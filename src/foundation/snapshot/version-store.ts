/**
 * VersionStore - 通用目录版本库（Phase 1918 Step B）
 *
 * 与 Snapshot（自动快照、30s 节流、失败后清理 .git）正交的独立能力：
 * - 版本库位于调用者指定目录的 `.git`（独立 Git 根，绝不向上发现 agent repo 冒充成功）
 * - 分支工作区由本模块在调用者允许的 workspace parent 创建（git worktree --detach +
 *   独立分支 ref + 每工作区独立 index），Git 元数据由本模块唯一访问
 * - begin/save 以 operationId 幂等：重试返回相同持久结果，不以节流返回假成功
 * - init/并发 init 不清理任何 `.git`，失败保留现场
 *
 * 磁盘事实布局（fs.baseDir 必须等于 repositoryDir，caller 装配责任，同 Snapshot）：
 *   <repositoryDir>/.git                     版本库（HEAD → refs/version/published）
 *   <repositoryDir>/.git/version-store/
 *     workspaces/<wsId>.json                 工作区记录（begin 幂等）
 *     saves/<wsId>/<opHash>.json             保存记录（save 幂等）
 *   refs/version/published                   已发布 ref（Step C 唯一提交点）
 *   refs/version/workspaces/<wsId>           候选分支（失败候选保留可达，不靠 reflog）
 *   refs/version/attempts/save-<wsId>-<h>    save 孤儿提交留存 ref
 */

import * as path from 'path';
import { formatErr, sha256Hex, sha256ShortHex } from '../node-utils/index.js';
import { exec as defaultExec } from '../process-exec/index.js';
import { isFileNotFound, type FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import type { GitExecError } from './git-errors.js';
import {
  emitSnapshotVersionInitFailed,
  emitSnapshotVersionPublishBusy,
  emitSnapshotVersionPublishConflict,
  emitSnapshotVersionPublished,
  emitSnapshotVersionPublishFailed,
  emitSnapshotVersionSaved,
  emitSnapshotVersionSaveFailed,
  emitSnapshotVersionWorkspaceBegan,
} from './audit-emit.js';
import {
  VersionStoreError,
  type EditWorkspace,
  type OperationId,
  type PublishInput,
  type PublishResult,
  type VersionId,
  type VersionStore,
} from './version-types.js';

// Node.js child_process / exec 抛错时未声明的 dynamic property（同 snapshot.ts 形态）
type NodeExecError = Error & Partial<GitExecError>;

const PUBLISHED_REF = 'refs/version/published';
const WORKSPACE_REF_PREFIX = 'refs/version/workspaces/';
const SAVE_ATTEMPT_REF_PREFIX = 'refs/version/attempts/save-';
const PUBLISH_ATTEMPT_REF_PREFIX = 'refs/version/attempts/publish-';
const STATE_DIR = '.git/version-store';
const ZERO_SHA = '0000000000000000000000000000000000000000';
const SHA1_RE = /^[0-9a-f]{40}$/;
/** save message 上限（argv 安全 + commit 对象尺寸护栏）；不透明内容原样写入 */
const MAX_MESSAGE_CHARS = 32_000;
/** publish metadata 上限：caller 原样提供的不透明内容，只校验大小/编码 */
const MAX_METADATA_CHARS = 16_000;
/** publish CAS 有界重试上限（耗尽返回 busy，不伪造语义冲突） */
const PUBLISH_MAX_ATTEMPTS = 3;
/** 孪生胜检测：published 首父链回扫深度上限 */
const TWIN_SCAN_DEPTH = 32;

interface WorkspaceRecord {
  schema: 1;
  kind: 'workspace';
  workspaceId: string;
  operationId: string;
  base: string;
  branch: string;
  path: string;
  gitDir: string;
}

interface SaveRecord {
  schema: 1;
  kind: 'save';
  operationId: string;
  workspaceId: string;
  version: string;
  messageSha256: string;
  noChange: boolean;
}

type PublishRecordResult =
  | { kind: 'published'; version: string }
  | { kind: 'conflict'; current: string; retainedCandidate: string };

interface PublishRecord {
  schema: 1;
  kind: 'publish';
  operationId: string;
  candidate: string;
  prefix: string;
  expectedPathRevision: string | null;
  metadataSha256: string;
  status: 'prepared' | 'completed';
  attempts: Array<{ commit: string; base: string }>;
  result?: PublishRecordResult;
}

type GitResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; exitCode: number; output: string };

export interface VersionStoreOptions {
  /** 版本库根目录绝对路径（必须等于 fs.baseDir，caller 装配责任） */
  repositoryDir: string;
  /** 分支工作区 parent 绝对路径（本模块在其内创建 <wsId>/ 工作区） */
  workspaceParent: string;
  fs: FileSystem;
  audit: AuditLog;
  exec?: typeof defaultExec;
}

function asVersionId(sha: string): VersionId {
  return sha as VersionId;
}

function validateOperationId(operationId: string): void {
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw new VersionStoreError('invalid_argument', 'operationId must be a non-empty string');
  }
}

/**
 * prefix 校验：字面相对子目录路径（模块不解释业务名）。拒绝绝对/越界/规范化
 * 段与 git pathspec / rev:path 语法元字符，保证 `-- <prefix>` 与 `<rev>:<prefix>`
 * 两处字面语义安全。
 */
function validatePrefix(prefix: string): string {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new VersionStoreError('invalid_argument', 'prefix must be a non-empty relative subdirectory path');
  }
  if (/[\0\\:*?[\]]/.test(prefix)) {
    throw new VersionStoreError('invalid_argument', `prefix contains forbidden character: ${prefix}`);
  }
  if (prefix.startsWith('/') || prefix.endsWith('/')) {
    throw new VersionStoreError('invalid_argument', `prefix must not start/end with '/': ${prefix}`);
  }
  for (const seg of prefix.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new VersionStoreError('invalid_argument', `prefix has invalid segment: ${prefix}`);
    }
  }
  return prefix;
}

class GitVersionStore implements VersionStore {
  private readonly repositoryDir: string;
  private readonly workspaceParent: string;
  private readonly fs: FileSystem;
  private readonly audit: AuditLog;
  private readonly execImpl: typeof defaultExec;
  /** fs.realpath('.git') 解析出的物理 git dir；open() 归属验证后设置 */
  private realGitDir = '';

  constructor(options: VersionStoreOptions) {
    this.repositoryDir = options.repositoryDir;
    this.workspaceParent = options.workspaceParent;
    this.fs = options.fs;
    this.audit = options.audit;
    this.execImpl = options.exec ?? defaultExec;
  }

  // ========================================================================
  // git 执行（argv 调用，绝不拼 shell；env 白名单 GIT_CONFIG_NOSYSTEM 防全局配置干扰）
  // ========================================================================

  /**
   * @param discovery true 时不显式传 --git-dir（init/归属验证/worktree 探测专用，
   *                  调用前必须已确认目标目录自身持有 .git，不会向上发现外来 repo）
   */
  private async gitExec(
    args: string[],
    opts?: { cwd?: string; gitDir?: string; discovery?: boolean; indexFile?: string; stdin?: string },
  ): Promise<GitResult> {
    const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1' };
    if (opts?.indexFile !== undefined) env.GIT_INDEX_FILE = opts.indexFile;
    let fullArgs = args;
    if (opts?.gitDir !== undefined) {
      fullArgs = ['--git-dir', opts.gitDir, ...args];
    } else if (!opts?.discovery && this.realGitDir) {
      fullArgs = ['--git-dir', this.realGitDir, ...args];
    }
    try {
      const r = await this.execImpl('git', fullArgs, {
        cwd: opts?.cwd ?? this.repositoryDir,
        env,
        stdin: opts?.stdin,
      });
      return { ok: true, stdout: r.output.trim(), stderr: r.stderr?.trim() ?? '' };
    } catch (e) {
      const ne = e as NodeExecError;
      if (typeof ne.exitCode === 'number') {
        return { ok: false, exitCode: ne.exitCode, output: ne.output ?? ne.message };
      }
      // spawn 失败 / 信号终止 / 超时：不可预期，原样冒泡
      throw e;
    }
  }

  private async git(
    args: string[],
    opts?: { cwd?: string; gitDir?: string; discovery?: boolean; indexFile?: string; stdin?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    const r = await this.gitExec(args, opts);
    if (!r.ok) {
      throw new VersionStoreError(
        'git_error',
        `git ${args[0]} failed (exit ${r.exitCode}): ${r.output.slice(0, 300)}`,
      );
    }
    return { stdout: r.stdout, stderr: r.stderr };
  }

  // ========================================================================
  // open：创建或验证独立 Git 根（幂等；并发安全；绝不清理 .git）
  // ========================================================================

  async open(): Promise<void> {
    if (!path.isAbsolute(this.repositoryDir)) {
      throw new VersionStoreError('invalid_argument', `repositoryDir must be absolute: ${this.repositoryDir}`);
    }
    if (!path.isAbsolute(this.workspaceParent)) {
      throw new VersionStoreError('invalid_argument', `workspaceParent must be absolute: ${this.workspaceParent}`);
    }

    if (!(await this.fs.exists('.git'))) {
      const init = await this.gitExec(['init'], { discovery: true });
      if (!init.ok) {
        emitSnapshotVersionInitFailed(this.audit, {
          dir: this.repositoryDir,
          kind: 'repo_init_failed',
          reason: init.output,
        });
        // phase 1918: 持久版本库不适用 Snapshot.init 的 tryCleanupGit——现场保留
        throw new VersionStoreError('repo_init_failed', `git init failed: ${init.output.slice(0, 300)}`);
      }
    }

    // 归属验证：git-dir 必须解析为本目录的 .git（拒绝 .git 指针文件 / 损坏现场）；
    // discovery 模式仅在 .git 已确认存在后使用，向上发现只会命中本目录。
    let resolvedGitDir: string;
    try {
      resolvedGitDir = await this.fs.realpath('.git');
    } catch (e) {
      throw new VersionStoreError('repo_invalid', `realpath(.git) failed: ${formatErr(e)}`, { cause: e });
    }
    const gitDirProbe = await this.gitExec(['rev-parse', '--path-format=absolute', '--git-dir'], { discovery: true });
    if (!gitDirProbe.ok) {
      emitSnapshotVersionInitFailed(this.audit, {
        dir: this.repositoryDir,
        kind: 'repo_invalid',
        reason: gitDirProbe.output,
      });
      throw new VersionStoreError('repo_invalid', `not a valid git repository: ${gitDirProbe.output.slice(0, 300)}`);
    }
    if (gitDirProbe.stdout !== resolvedGitDir) {
      emitSnapshotVersionInitFailed(this.audit, {
        dir: this.repositoryDir,
        kind: 'repo_invalid',
        reason: `git-dir ${gitDirProbe.stdout} != ${resolvedGitDir}`,
      });
      throw new VersionStoreError('repo_invalid', 'repository .git does not resolve to the local git dir');
    }
    // 独立根验证：toplevel 必须就是 repositoryDir（绝不接受向上发现的 agent repo）
    const topProbe = await this.git(['rev-parse', '--path-format=absolute', '--show-toplevel'], { discovery: true });
    if (topProbe.stdout !== path.dirname(resolvedGitDir)) {
      emitSnapshotVersionInitFailed(this.audit, {
        dir: this.repositoryDir,
        kind: 'repo_invalid',
        reason: `toplevel ${topProbe.stdout} != ${path.dirname(resolvedGitDir)}`,
      });
      throw new VersionStoreError('repo_invalid', 'repository is not an independent git root');
    }
    const format = await this.git(['rev-parse', '--show-object-format'], { discovery: true });
    if (format.stdout !== 'sha1') {
      throw new VersionStoreError('repo_invalid', `unsupported object format: ${format.stdout}`);
    }
    this.realGitDir = resolvedGitDir;

    // 本地身份 + 归属标记（幂等写入）
    await this.git(['config', 'user.name', 'chestnut']);
    await this.git(['config', 'user.email', 'chestnut@local']);
    await this.git(['config', 'chestnut.versionstore', '1918']);

    // published ref：缺失则建空初始提交；create-only CAS 保证并发 init 只有一方创建，
    // 败者重读已存在的 ref 视为成功（不清理、不覆盖）
    const published = await this.gitExec(['rev-parse', '--verify', '--quiet', `${PUBLISHED_REF}^{commit}`]);
    if (!published.ok) {
      const emptyTree = (await this.git(['mktree'], { stdin: '' })).stdout;
      const c0 = (
        await this.git(['commit-tree', emptyTree, '-m', 'version-store init'])
      ).stdout;
      const cas = await this.gitExec(['update-ref', PUBLISHED_REF, c0, ZERO_SHA]);
      if (!cas.ok) {
        const recheck = await this.gitExec(['rev-parse', '--verify', '--quiet', `${PUBLISHED_REF}^{commit}`]);
        if (!recheck.ok) {
          emitSnapshotVersionInitFailed(this.audit, {
            dir: this.repositoryDir,
            kind: 'repo_init_failed',
            reason: cas.output,
          });
          throw new VersionStoreError('repo_init_failed', `published ref init failed: ${cas.output.slice(0, 300)}`);
        }
      }
    }
    await this.git(['symbolic-ref', 'HEAD', PUBLISHED_REF]);
  }

  // ========================================================================
  // 记录持久化（操作事实唯一权威，FileSystem writeAtomic）
  // ========================================================================

  private async readRecord(rel: string): Promise<unknown | undefined> {
    let raw: string;
    try {
      raw = await this.fs.read(rel);
    } catch (e) {
      if (isFileNotFound(e)) return undefined;
      throw e;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (e) {
      throw new VersionStoreError('record_corrupt', `corrupt record ${rel}: ${formatErr(e)}`, { cause: e });
    }
  }

  private async writeRecord(rel: string, value: unknown): Promise<void> {
    await this.fs.ensureDir(path.dirname(rel));
    await this.fs.writeAtomic(rel, JSON.stringify(value));
  }

  private workspaceRecordPath(workspaceId: string): string {
    return path.join(STATE_DIR, 'workspaces', `${workspaceId}.json`);
  }

  private saveRecordPath(workspaceId: string, opHash: string): string {
    return path.join(STATE_DIR, 'saves', workspaceId, `${opHash}.json`);
  }

  // ========================================================================
  // 版本 / 工作区校验
  // ========================================================================

  /** 版本标识只能由库内验证过的对象解析：40-hex + cat-file 证实为 commit */
  private async requireCommit(sha: string, what: string): Promise<VersionId> {
    if (typeof sha !== 'string' || !SHA1_RE.test(sha)) {
      throw new VersionStoreError('invalid_argument', `${what} must be a 40-hex sha1: ${String(sha)}`);
    }
    const r = await this.gitExec(['cat-file', '-t', sha]);
    if (!r.ok || r.stdout !== 'commit') {
      throw new VersionStoreError('unknown_version', `${what} does not resolve to a commit: ${sha}`);
    }
    return asVersionId(sha);
  }

  private worktreesPrefix(): string {
    return this.realGitDir + path.sep + 'worktrees' + path.sep;
  }

  private assertWorkspaceRecord(raw: unknown, workspaceId: string): WorkspaceRecord {
    const r = raw as Partial<WorkspaceRecord> | undefined;
    if (
      r === null || typeof r !== 'object' ||
      r.schema !== 1 || r.kind !== 'workspace' ||
      r.workspaceId !== workspaceId ||
      typeof r.operationId !== 'string' ||
      typeof r.base !== 'string' || !SHA1_RE.test(r.base) ||
      r.branch !== WORKSPACE_REF_PREFIX + workspaceId ||
      typeof r.path !== 'string' ||
      typeof r.gitDir !== 'string' || !r.gitDir.startsWith(this.worktreesPrefix())
    ) {
      throw new VersionStoreError('record_corrupt', `workspace record invalid: ${workspaceId}`);
    }
    return r as WorkspaceRecord;
  }

  private async loadWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord> {
    const raw = await this.readRecord(this.workspaceRecordPath(workspaceId));
    if (raw === undefined) {
      throw new VersionStoreError('unknown_workspace', `unknown workspace: ${workspaceId}`);
    }
    return this.assertWorkspaceRecord(raw, workspaceId);
  }

  /**
   * 探测 wsPath 是否已注册为本库 worktree；返回其 admin git-dir（含归属校验）或 null。
   * git -C 处理目录缺失（exit 128 → null），不会向上发现外来 repo 冒充成功
   * （containment 校验拒绝 realGitDir/worktrees/ 之外的一切解析结果）。
   */
  private async probeWorktreeGitDir(wsPath: string): Promise<string | null> {
    const r = await this.gitExec(
      ['-C', wsPath, 'rev-parse', '--path-format=absolute', '--git-dir'],
      { discovery: true },
    );
    if (!r.ok) return null;
    if (!r.stdout.startsWith(this.worktreesPrefix())) return null;
    return r.stdout;
  }

  // ========================================================================
  // begin：开启（或幂等重开）分支工作区
  // ========================================================================

  async begin(input: { operationId: OperationId; base: VersionId }): Promise<EditWorkspace> {
    validateOperationId(input.operationId);
    const base = await this.requireCommit(input.base, 'base');
    const workspaceId = `ws-${sha256ShortHex(`begin:${input.operationId}`, 24)}`;

    // 幂等重开：记录在场 → 校验分支仍解析 → 原样返回（不触碰工作区目录，保留未保存编辑）
    const existing = await this.readRecord(this.workspaceRecordPath(workspaceId));
    if (existing !== undefined) {
      const rec = this.assertWorkspaceRecord(existing, workspaceId);
      const tip = await this.gitExec(['rev-parse', '--verify', '--quiet', `${rec.branch}^{commit}`]);
      if (!tip.ok) {
        throw new VersionStoreError('record_corrupt', `workspace branch missing: ${rec.branch}`);
      }
      return { id: rec.workspaceId, base: asVersionId(rec.base), path: rec.path, branch: rec.branch };
    }

    const branch = WORKSPACE_REF_PREFIX + workspaceId;
    // 分支：create-only CAS；并发孪生已建则采纳（重启不新建重复分支）
    const tipProbe = await this.gitExec(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
    if (!tipProbe.ok) {
      const cas = await this.gitExec(['update-ref', branch, base, ZERO_SHA]);
      if (!cas.ok) {
        await this.git(['rev-parse', '--verify', `${branch}^{commit}`]);
      }
    }

    const wsPath = path.join(this.workspaceParent, workspaceId);
    // 工作区：已注册则采纳；否则 --detach add（分支 ref 由本模块独立持有，
    // 工作区 HEAD 游离不影响 save 的 commit-tree + CAS 协议）
    let gitDir = await this.probeWorktreeGitDir(wsPath);
    if (gitDir === null) {
      const add = await this.gitExec(['worktree', 'add', '--detach', wsPath, base]);
      if (!add.ok) {
        // 并发孪生可能已注册：重探一次，仍无 → 真实失败
        gitDir = await this.probeWorktreeGitDir(wsPath);
        if (gitDir === null) {
          throw new VersionStoreError('git_error', `git worktree add failed: ${add.output.slice(0, 300)}`);
        }
      }
    }
    if (gitDir === null) {
      gitDir = await this.probeWorktreeGitDir(wsPath);
    }
    if (gitDir === null) {
      throw new VersionStoreError('git_error', `worktree registration probe failed: ${wsPath}`);
    }

    const record: WorkspaceRecord = {
      schema: 1,
      kind: 'workspace',
      workspaceId,
      operationId: input.operationId,
      base,
      branch,
      path: wsPath,
      gitDir,
    };
    await this.writeRecord(this.workspaceRecordPath(workspaceId), record);
    emitSnapshotVersionWorkspaceBegan(this.audit, {
      dir: this.repositoryDir,
      workspace: workspaceId,
      base,
      branch,
      operationId: input.operationId,
    });
    return { id: workspaceId, base, path: wsPath, branch };
  }

  // ========================================================================
  // save：无节流持久保存完整候选内容（独立 index + commit-tree + 分支 CAS）
  // ========================================================================

  async save(input: { workspaceId: string; operationId: OperationId; message: string }): Promise<VersionId> {
    validateOperationId(input.operationId);
    if (typeof input.message !== 'string' || input.message.length === 0) {
      throw new VersionStoreError('invalid_argument', 'message must be a non-empty string');
    }
    if (input.message.length > MAX_MESSAGE_CHARS) {
      throw new VersionStoreError('invalid_argument', `message exceeds ${MAX_MESSAGE_CHARS} chars`);
    }
    const rec = await this.loadWorkspaceRecord(input.workspaceId);
    const opHash = sha256Hex(`save:${rec.workspaceId}:${input.operationId}`);
    const savePath = this.saveRecordPath(rec.workspaceId, opHash);

    // 幂等重放：记录在场 → 校验输入未漂移 → 返回相同持久结果
    const existing = await this.readRecord(savePath);
    if (existing !== undefined) {
      const r = existing as Partial<SaveRecord>;
      if (
        r === null || typeof r !== 'object' ||
        r.schema !== 1 || r.kind !== 'save' ||
        r.operationId !== input.operationId ||
        r.workspaceId !== rec.workspaceId ||
        typeof r.version !== 'string' || !SHA1_RE.test(r.version)
      ) {
        throw new VersionStoreError('record_corrupt', `save record invalid: ${savePath}`);
      }
      if (r.messageSha256 !== sha256Hex(input.message)) {
        throw new VersionStoreError('invalid_argument', 'operationId replayed with a different message');
      }
      return asVersionId(r.version);
    }

    // 完整捕获：-f 覆盖 ignore 规则，候选内容不静默缺字节（独立 index 在工作区 admin dir 内）
    const add = await this.gitExec(['--work-tree', rec.path, 'add', '-A', '-f'], { cwd: rec.path, gitDir: rec.gitDir });
    if (!add.ok) {
      emitSnapshotVersionSaveFailed(this.audit, {
        dir: this.repositoryDir,
        reason: add.output,
        workspace: rec.workspaceId,
        operationId: input.operationId,
      });
      throw new VersionStoreError('git_error', `git add failed (exit ${add.exitCode}): ${add.output.slice(0, 300)}`);
    }
    const tree = (await this.git(['--work-tree', rec.path, 'write-tree'], { cwd: rec.path, gitDir: rec.gitDir })).stdout;

    const tip = (await this.git(['rev-parse', '--verify', rec.branch])).stdout;
    const tipTree = (await this.git(['rev-parse', `${tip}^{tree}`])).stdout;

    let version = tip;
    let noChange = false;
    if (tree === tipTree) {
      // 空修改：稳定提交身份（当前分支尖），不制造新提交
      noChange = true;
    } else {
      const commitMessage = `${input.message}\n\nworkspace: ${rec.workspaceId}\noperation-id: ${input.operationId}\n`;
      const newCommit = (await this.git(['commit-tree', tree, '-p', tip, '-m', commitMessage])).stdout;
      // 孤儿留存：分支 CAS 失败也不丢提交（可达 ref，不靠 reflog）
      await this.git(['update-ref', `${SAVE_ATTEMPT_REF_PREFIX}${rec.workspaceId}-${opHash.slice(0, 16)}`, newCommit]);
      const cas = await this.gitExec(['update-ref', rec.branch, newCommit, tip]);
      if (!cas.ok) {
        const now = await this.gitExec(['rev-parse', '--verify', '--quiet', rec.branch]);
        if (now.ok && now.stdout !== tip) {
          emitSnapshotVersionSaveFailed(this.audit, {
            dir: this.repositoryDir,
            reason: `branch advanced concurrently: ${tip} -> ${now.stdout}`,
            workspace: rec.workspaceId,
            operationId: input.operationId,
          });
          throw new VersionStoreError('save_conflict', `workspace branch advanced concurrently: ${rec.branch}`);
        }
        emitSnapshotVersionSaveFailed(this.audit, {
          dir: this.repositoryDir,
          reason: cas.output,
          workspace: rec.workspaceId,
          operationId: input.operationId,
        });
        throw new VersionStoreError('git_error', `branch update failed: ${cas.output.slice(0, 300)}`);
      }
      version = newCommit;
    }

    const record: SaveRecord = {
      schema: 1,
      kind: 'save',
      operationId: input.operationId,
      workspaceId: rec.workspaceId,
      version,
      messageSha256: sha256Hex(input.message),
      noChange,
    };
    await this.writeRecord(savePath, record);
    emitSnapshotVersionSaved(this.audit, {
      dir: this.repositoryDir,
      workspace: rec.workspaceId,
      version,
      operationId: input.operationId,
      outcome: noChange ? 'no_change' : undefined,
    });
    return asVersionId(version);
  }

  // ========================================================================
  // publish（phase 1918 Step C）：按路径条件发布，CAS 是唯一提交点
  // ========================================================================

  private publishRecordPath(opHash: string): string {
    return path.join(STATE_DIR, 'publishes', `${opHash}.json`);
  }

  private assertPublishRecord(raw: unknown, input: PublishInput, opHash: string, metadataSha: string): PublishRecord {
    const r = raw as Partial<PublishRecord> | undefined;
    if (
      r === null || typeof r !== 'object' ||
      r.schema !== 1 || r.kind !== 'publish' ||
      r.operationId !== input.operationId ||
      (r.status !== 'prepared' && r.status !== 'completed') ||
      !Array.isArray(r.attempts) ||
      !r.attempts.every(a => typeof a?.commit === 'string' && SHA1_RE.test(a.commit) && typeof a?.base === 'string' && SHA1_RE.test(a.base))
    ) {
      throw new VersionStoreError('record_corrupt', `publish record invalid: ${opHash}`);
    }
    // 幂等键输入漂移 = 调用方契约错误（重放必须带相同输入）
    if (
      r.candidate !== input.candidate ||
      r.prefix !== input.prefix ||
      r.expectedPathRevision !== (input.expectedPathRevision as string | null) ||
      r.metadataSha256 !== metadataSha
    ) {
      throw new VersionStoreError('invalid_argument', 'operationId replayed with different publish inputs');
    }
    if (r.status === 'completed') {
      const res = r.result as Partial<PublishRecordResult> | undefined;
      const validPublished = res?.kind === 'published' && typeof res.version === 'string' && SHA1_RE.test(res.version);
      const validConflict = res?.kind === 'conflict' && typeof res.current === 'string' && SHA1_RE.test(res.current)
        && typeof (res as { retainedCandidate?: unknown }).retainedCandidate === 'string';
      if (!validPublished && !validConflict) {
        throw new VersionStoreError('record_corrupt', `publish record result invalid: ${opHash}`);
      }
    }
    return r as PublishRecord;
  }

  /** 该 prefix 最近一次发布变更的版本身份（TREESAME 简化，改后改回仍产生新身份） */
  private async pathRevisionOf(version: string, prefix: string): Promise<VersionId | null> {
    const r = await this.gitExec(['rev-list', '--first-parent', '-n', '1', version, '--', prefix]);
    if (!r.ok) {
      throw new VersionStoreError('git_error', `git rev-list failed: ${r.output.slice(0, 300)}`);
    }
    return r.stdout === '' ? null : asVersionId(r.stdout);
  }

  /** published 首父链有界回扫：本 operation-id 的发布提交是否已在历史中（孪生胜检测） */
  private async findOperationCommit(head: string, operationId: string): Promise<string | null> {
    const r = await this.gitExec(['log', '--first-parent', '-n', String(TWIN_SCAN_DEPTH), '--format=%H%x00%B%x00', head]);
    if (!r.ok || r.stdout === '') return null;
    const parts = r.stdout.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = parts[i].replace(/^\n+/, '');
      const body = parts[i + 1];
      if (SHA1_RE.test(sha) && body.split('\n').includes(`operation-id: ${operationId}`)) {
        return sha;
      }
    }
    return null;
  }

  /** 私有 index 组合：最新 published tree 替换该子树，其他子树原样保留 */
  private async composeTree(published: string, candidate: string, prefix: string, indexFile: string): Promise<string> {
    await this.git(['read-tree', published], { indexFile });
    await this.git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', prefix], { indexFile });
    const sub = await this.gitExec(['rev-parse', '--verify', '--quiet', `${candidate}:${prefix}`]);
    if (sub.ok && sub.stdout !== '') {
      await this.git(['read-tree', `--prefix=${prefix}/`, sub.stdout], { indexFile });
    }
    return (await this.git(['write-tree'], { indexFile })).stdout;
  }

  /** 完整结果记录后返回（成功 CAS 之外的唯一事实出口）；replay 亦走此路径 */
  private async completePublish(
    recPath: string,
    rec: PublishRecord,
    result: PublishRecordResult,
    outcome?: 'recovered',
  ): Promise<PublishResult> {
    rec.status = 'completed';
    rec.result = result;
    await this.writeRecord(recPath, rec);
    if (result.kind === 'published') {
      emitSnapshotVersionPublished(this.audit, {
        dir: this.repositoryDir,
        prefix: rec.prefix,
        version: result.version,
        operationId: rec.operationId,
        outcome,
      });
      return { kind: 'published', version: asVersionId(result.version) };
    }
    emitSnapshotVersionPublishConflict(this.audit, {
      dir: this.repositoryDir,
      prefix: rec.prefix,
      current: result.current,
      candidate: result.retainedCandidate,
      operationId: rec.operationId,
    });
    return {
      kind: 'conflict',
      current: asVersionId(result.current),
      retainedCandidate: asVersionId(result.retainedCandidate),
    };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    validateOperationId(input.operationId);
    const prefix = validatePrefix(input.prefix);
    const candidate = await this.requireCommit(input.candidate, 'candidate');
    if (input.expectedPathRevision !== null) {
      await this.requireCommit(input.expectedPathRevision, 'expectedPathRevision');
    }
    if (typeof input.metadata !== 'string' || input.metadata.length > MAX_METADATA_CHARS) {
      throw new VersionStoreError('invalid_argument', `metadata must be a string of at most ${MAX_METADATA_CHARS} chars`);
    }
    const metadataSha = sha256Hex(input.metadata);
    const opHash = sha256Hex(`publish:${input.operationId}`);
    const recPath = this.publishRecordPath(opHash);

    let rec: PublishRecord;
    const existing = await this.readRecord(recPath);
    if (existing !== undefined) {
      rec = this.assertPublishRecord(existing, input, opHash, metadataSha);
      if (rec.status === 'completed') {
        // 反复提交同 operationId 重放相同持久结果
        const res = rec.result as PublishRecordResult;
        if (res.kind === 'published') return { kind: 'published', version: asVersionId(res.version) };
        return {
          kind: 'conflict',
          current: asVersionId(res.current),
          retainedCandidate: asVersionId(res.retainedCandidate),
        };
      }
      // 恢复：最近尝试已赢得 CAS（线性 CAS 历史下 祖先 ⟺ 曾 published 充要）→
      // 按 ref 历史识别已提交，不再次发布；未赢则保持待重试进入新尝试
      const last = rec.attempts[rec.attempts.length - 1];
      if (last !== undefined) {
        const won = await this.gitExec(['merge-base', '--is-ancestor', last.commit, PUBLISHED_REF]);
        if (won.ok) {
          return this.completePublish(recPath, rec, { kind: 'published', version: last.commit }, 'recovered');
        }
        if (won.exitCode !== 1) {
          throw new VersionStoreError('git_error', `git merge-base failed: ${won.output.slice(0, 300)}`);
        }
      }
    } else {
      // 先持久化分支候选及通用 operation 记录，再进入尝试（prepare→CAS→receipt）
      rec = {
        schema: 1,
        kind: 'publish',
        operationId: input.operationId,
        candidate,
        prefix,
        expectedPathRevision: input.expectedPathRevision as string | null,
        metadataSha256: metadataSha,
        status: 'prepared',
        attempts: [],
      };
      await this.writeRecord(recPath, rec);
    }

    for (let attempt = 0; attempt < PUBLISH_MAX_ATTEMPTS; attempt++) {
      const head = (await this.git(['rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`])).stdout;

      // 孪生胜：同 operationId 的发布提交已在 published 首父链 → 重放其结果
      const twin = await this.findOperationCommit(head, input.operationId);
      if (twin !== null) {
        return this.completePublish(recPath, rec, { kind: 'published', version: twin });
      }

      // 路径基准：该 prefix 最近一次发布变更的版本身份（非 tree hash，改后改回仍过期）
      const currentRevision = await this.pathRevisionOf(head, prefix);
      if (currentRevision !== input.expectedPathRevision) {
        return this.completePublish(recPath, rec, {
          kind: 'conflict',
          current: head,
          retainedCandidate: candidate,
        });
      }

      // 候选范围：相对其与其与 published 的分叉点，候选只许修改 prefix 子树
      const forkPoint = (await this.git(['merge-base', candidate, head])).stdout;
      const diff = await this.git(['diff', '--name-only', '-z', forkPoint, candidate]);
      const changedPaths = diff.stdout.split('\0').filter(s => s.length > 0);
      for (const p of changedPaths) {
        if (p !== prefix && !p.startsWith(`${prefix}/`)) {
          emitSnapshotVersionPublishFailed(this.audit, {
            dir: this.repositoryDir,
            reason: `candidate modifies path outside prefix: ${p}`,
            prefix,
            operationId: input.operationId,
          });
          // 拒绝并保留候选（工作区分支 ref 可达，绝不删除分支清理失败尝试）
          throw new VersionStoreError('candidate_out_of_scope', `candidate modifies path outside prefix: ${p}`);
        }
      }

      const indexFile = path.join(
        this.realGitDir, 'version-store', 'index', `publish-${opHash.slice(0, 16)}-${rec.attempts.length}.index`,
      );
      await this.fs.ensureDir(path.join(STATE_DIR, 'index'));
      const newTree = await this.composeTree(head, candidate, prefix, indexFile);

      const headTree = (await this.git(['rev-parse', `${head}^{tree}`])).stdout;
      if (newTree === headTree) {
        // 候选内容已完整反映在当前 published：真实结果即 published(head)，无需推进 ref
        return this.completePublish(recPath, rec, { kind: 'published', version: head });
      }

      const commit = (await this.git([
        'commit-tree', newTree, '-p', head, '-m', `publish ${prefix}\n\noperation-id: ${input.operationId}\n`,
      ])).stdout;
      // 每次发布尝试均以 refs 保持可达；prepare 记录候选、旧 ref、目标 commit、operationId
      await this.git(['update-ref', `${PUBLISH_ATTEMPT_REF_PREFIX}${opHash.slice(0, 16)}-${rec.attempts.length}`, commit]);
      rec.attempts.push({ commit, base: head });
      await this.writeRecord(recPath, rec);

      // 唯一提交点：带旧值的 update-ref 原子推进（无默认无条件 force）
      const cas = await this.gitExec(['update-ref', PUBLISHED_REF, commit, head]);
      if (cas.ok) {
        return this.completePublish(recPath, rec, { kind: 'published', version: commit });
      }
      // CAS 失败：下轮循环顶部重读 head 并重新判路径基准（路径未变可系统重试，
      // 已变返回 conflict）；ref 未动的 transient lock/IO 占用一次有界额度，
      // 不归为语义冲突
    }

    emitSnapshotVersionPublishBusy(this.audit, {
      dir: this.repositoryDir,
      prefix,
      operationId: input.operationId,
      attempts: rec.attempts.length,
    });
    // 有界耗尽返回 busy；记录保持 prepared，同 operationId 重试可续作
    return { kind: 'busy', operationId: input.operationId };
  }
}

/**
 * phase 1918 Step B：独立失败协议——预期失败抛 typed VersionStoreError
 * （kind 携带分类），不可预期失败（spawn/signal/timeout/IO）原样冒泡；
 * 绝不清理 .git / 工作区 / 操作记录。
 */
export async function createVersionStore(options: VersionStoreOptions): Promise<VersionStore> {
  const store = new GitVersionStore(options);
  await store.open();
  return store;
}
