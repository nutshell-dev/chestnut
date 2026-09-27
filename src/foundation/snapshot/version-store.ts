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
 *     saves/<wsId>/<opHash>.json             保存记录（save 幂等；prepared→completed 分阶段事实）
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
  emitSnapshotVersionExported,
  emitSnapshotVersionExportFailed,
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
  type OperationInspection,
  type PublishInput,
  type PublishResult,
  type VersionHistoryEntry,
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
  messageSha256: string;
  /**
   * phase 1920：分阶段持久事实。旧记录（pre-1920）无此字段 ⟺ completed（旧实现只在
   * 完成时落记录）。prepared 期间 tree/baseTip/candidate 按写入先后逐步补全：
   * 每个不可逆步骤（捕获/建提交/CAS）之前先把足以恢复的事实落盘。
   */
  status?: 'prepared' | 'completed';
  /** prepared：已捕获 tree（重试绝不重新 add 可变工作区） */
  tree?: string;
  /** 候选 CAS 的旧值（捕获/建提交时的分支尖） */
  baseTip?: string;
  /** prepared：已建提交（确定性 attempt ref 亦可达），CAS 结果未定 */
  candidate?: string;
  /** completed：首次保存版本（唯一事实出口，重试只能返回它） */
  version?: string;
  noChange?: boolean;
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
  /**
   * phase 1920：metadata 原文持久化（大小上限校验同输入）。旧记录（pre-1920）无此字段：
   * 原文不可完整恢复，重放只能比 hash，inspectOperation 以 null 显式标记，绝不伪造依据。
   */
  metadata?: string;
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
   * @param raw true 时 stdout 不 trim（blob 等字节内容读取专用）
   */
  private async gitExec(
    args: string[],
    opts?: { cwd?: string; gitDir?: string; discovery?: boolean; indexFile?: string; stdin?: string; raw?: boolean },
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
      return { ok: true, stdout: opts?.raw ? r.output : r.output.trim(), stderr: r.stderr?.trim() ?? '' };
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
    opts?: { cwd?: string; gitDir?: string; discovery?: boolean; indexFile?: string; stdin?: string; raw?: boolean },
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

    // 幂等重开：记录在场 → 逐字段校验 operationId 绑定输入未漂移（phase 1920：含 base）→
    // 校验分支仍解析 → 原样返回（不触碰工作区目录，保留未保存编辑）
    const existing = await this.readRecord(this.workspaceRecordPath(workspaceId));
    if (existing !== undefined) {
      const rec = this.assertWorkspaceRecord(existing, workspaceId);
      if (rec.operationId !== input.operationId || rec.base !== base) {
        // 输入漂移 = 调用方契约错误：不覆盖旧工作区、不静默采用新基准
        throw new VersionStoreError('invalid_argument', 'operationId replayed with different begin inputs');
      }
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

  /** save 记录形态校验：旧记录（无 status）按 completed 判读；prepared 各阶段字段完整性强校验 */
  private assertSaveRecordShape(raw: unknown, savePath: string, rec: WorkspaceRecord, operationId: string): SaveRecord {
    const r = raw as Partial<SaveRecord> | undefined;
    if (
      r === null || typeof r !== 'object' ||
      r.schema !== 1 || r.kind !== 'save' ||
      r.operationId !== operationId ||
      r.workspaceId !== rec.workspaceId ||
      typeof r.messageSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.messageSha256)
    ) {
      throw new VersionStoreError('record_corrupt', `save record invalid: ${savePath}`);
    }
    const status = r.status ?? 'completed';
    if (status === 'completed') {
      if (typeof r.version !== 'string' || !SHA1_RE.test(r.version)) {
        throw new VersionStoreError('record_corrupt', `save record completed without version: ${savePath}`);
      }
    } else if (status === 'prepared') {
      const badTree = r.tree !== undefined && (typeof r.tree !== 'string' || !SHA1_RE.test(r.tree));
      const badBaseTip = r.baseTip !== undefined && (typeof r.baseTip !== 'string' || !SHA1_RE.test(r.baseTip));
      const badCandidate = r.candidate !== undefined &&
        (typeof r.candidate !== 'string' || !SHA1_RE.test(r.candidate) || r.baseTip === undefined);
      if (r.version !== undefined || badTree || badBaseTip || badCandidate) {
        throw new VersionStoreError('record_corrupt', `save record prepared shape invalid: ${savePath}`);
      }
    } else {
      throw new VersionStoreError('record_corrupt', `save record unknown status: ${savePath}`);
    }
    return r as SaveRecord;
  }

  /** completed 结果落盘是唯一事实出口；重放与恢复亦走此路径 */
  private async completeSave(savePath: string, record: SaveRecord, version: string, noChange: boolean): Promise<VersionId> {
    record.status = 'completed';
    record.version = version;
    record.noChange = noChange;
    await this.writeRecord(savePath, record);
    emitSnapshotVersionSaved(this.audit, {
      dir: this.repositoryDir,
      workspace: record.workspaceId,
      version,
      operationId: record.operationId,
      outcome: noChange ? 'no_change' : undefined,
    });
    return asVersionId(version);
  }

  /**
   * phase 1920：prepared 记录的可恢复续作。不变量：同一 operationId 只能返回首次保存
   * 版本——候选（或捕获 tree）一旦持久化，重试绝不重新 add 可变工作区；CAS 后回执
   * 丢失按分支祖先关系识别已提交（线性分支历史下 祖先 ⟺ 曾 CAS 成功）。
   */
  private async resumeSave(
    savePath: string,
    record: SaveRecord,
    rec: WorkspaceRecord,
    opHash: string,
    message: string,
  ): Promise<VersionId> {
    const attemptRef = `${SAVE_ATTEMPT_REF_PREFIX}${rec.workspaceId}-${opHash.slice(0, 16)}`;

    // (a) 候选已建立（记录或确定性 attempt ref 可达）→ 判定 CAS 结果，绝不重新捕获
    let candidate = record.candidate;
    if (candidate === undefined) {
      const probe = await this.gitExec(['rev-parse', '--verify', '--quiet', attemptRef]);
      if (probe.ok && SHA1_RE.test(probe.stdout)) {
        // 崩溃发生在建提交之后、记录补全之前：候选由 attempt ref 恢复并先落盘
        candidate = probe.stdout;
        record.candidate = candidate;
        if (record.baseTip === undefined) {
          throw new VersionStoreError('record_corrupt', `save record candidate without baseTip: ${savePath}`);
        }
        await this.writeRecord(savePath, record);
      }
    }
    if (candidate !== undefined) {
      const won = await this.gitExec(['merge-base', '--is-ancestor', candidate, rec.branch]);
      if (won.ok) {
        return this.completeSave(savePath, record, candidate, false);
      }
      if (won.exitCode !== 1) {
        throw new VersionStoreError('git_error', `git merge-base failed: ${won.output.slice(0, 300)}`);
      }
      // CAS 从未成功：以记录的 baseTip 重试同一 CAS（候选身份不变，不产生第二次捕获）
      const cas = await this.gitExec(['update-ref', rec.branch, candidate, record.baseTip as string]);
      if (cas.ok) {
        return this.completeSave(savePath, record, candidate, false);
      }
      const now = await this.gitExec(['rev-parse', '--verify', '--quiet', rec.branch]);
      if (now.ok && now.stdout !== record.baseTip) {
        emitSnapshotVersionSaveFailed(this.audit, {
          dir: this.repositoryDir,
          reason: `branch advanced concurrently: ${record.baseTip as string} -> ${now.stdout}`,
          workspace: rec.workspaceId,
          operationId: record.operationId,
        });
        throw new VersionStoreError('save_conflict', `workspace branch advanced concurrently: ${rec.branch}`);
      }
      emitSnapshotVersionSaveFailed(this.audit, {
        dir: this.repositoryDir,
        reason: cas.output,
        workspace: rec.workspaceId,
        operationId: record.operationId,
      });
      throw new VersionStoreError('git_error', `branch update failed: ${cas.output.slice(0, 300)}`);
    }

    // (b) 捕获（或复用已持久 tree）：tree+baseTip 先落盘，再建提交，再 CAS
    let tree = record.tree;
    if (tree === undefined) {
      // 完整捕获：-f 覆盖 ignore 规则，候选内容不静默缺字节（独立 index 在工作区 admin dir 内）
      const add = await this.gitExec(['--work-tree', rec.path, 'add', '-A', '-f'], { cwd: rec.path, gitDir: rec.gitDir });
      if (!add.ok) {
        emitSnapshotVersionSaveFailed(this.audit, {
          dir: this.repositoryDir,
          reason: add.output,
          workspace: rec.workspaceId,
          operationId: record.operationId,
        });
        throw new VersionStoreError('git_error', `git add failed (exit ${add.exitCode}): ${add.output.slice(0, 300)}`);
      }
      tree = (await this.git(['--work-tree', rec.path, 'write-tree'], { cwd: rec.path, gitDir: rec.gitDir })).stdout;
      record.tree = tree;
      record.baseTip = (await this.git(['rev-parse', '--verify', rec.branch])).stdout;
      await this.writeRecord(savePath, record);
    }

    const tip = (await this.git(['rev-parse', '--verify', rec.branch])).stdout;
    const tipTree = (await this.git(['rev-parse', `${tip}^{tree}`])).stdout;
    if (tree === tipTree) {
      // 空修改：稳定提交身份（当前分支尖），不制造新提交
      return this.completeSave(savePath, record, tip, true);
    }

    const commitMessage = `${message}\n\nworkspace: ${rec.workspaceId}\noperation-id: ${record.operationId}\n`;
    const newCommit = (await this.git(['commit-tree', tree, '-p', tip, '-m', commitMessage])).stdout;
    // 孤儿留存：分支 CAS 失败也不丢提交（确定性 attempt ref 可达，不靠 reflog）
    await this.git(['update-ref', attemptRef, newCommit]);
    record.candidate = newCommit;
    record.baseTip = tip;
    await this.writeRecord(savePath, record);

    const cas = await this.gitExec(['update-ref', rec.branch, newCommit, tip]);
    if (!cas.ok) {
      const now = await this.gitExec(['rev-parse', '--verify', '--quiet', rec.branch]);
      if (now.ok && now.stdout !== tip) {
        emitSnapshotVersionSaveFailed(this.audit, {
          dir: this.repositoryDir,
          reason: `branch advanced concurrently: ${tip} -> ${now.stdout}`,
          workspace: rec.workspaceId,
          operationId: record.operationId,
        });
        throw new VersionStoreError('save_conflict', `workspace branch advanced concurrently: ${rec.branch}`);
      }
      emitSnapshotVersionSaveFailed(this.audit, {
        dir: this.repositoryDir,
        reason: cas.output,
        workspace: rec.workspaceId,
        operationId: record.operationId,
      });
      throw new VersionStoreError('git_error', `branch update failed: ${cas.output.slice(0, 300)}`);
    }
    return this.completeSave(savePath, record, newCommit, false);
  }

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
    const messageSha = sha256Hex(input.message);

    // 幂等重放/恢复：记录在场 → 校验输入未漂移 → 完成态直接返回首次版本，prepared 续作
    const existing = await this.readRecord(savePath);
    if (existing !== undefined) {
      const record = this.assertSaveRecordShape(existing, savePath, rec, input.operationId);
      if (record.messageSha256 !== messageSha) {
        throw new VersionStoreError('invalid_argument', 'operationId replayed with a different message');
      }
      if (record.status !== 'prepared') {
        return asVersionId(record.version as string);
      }
      return this.resumeSave(savePath, record, rec, opHash, input.message);
    }

    // 首次调用：先把 operationId 绑定的输入落盘（prepared），再进入捕获/CAS 流程
    const prepared: SaveRecord = {
      schema: 1,
      kind: 'save',
      operationId: input.operationId,
      workspaceId: rec.workspaceId,
      messageSha256: messageSha,
      status: 'prepared',
    };
    await this.writeRecord(savePath, prepared);
    return this.resumeSave(savePath, prepared, rec, opHash, input.message);
  }

  // ========================================================================
  // publish（phase 1918 Step C）：按路径条件发布，CAS 是唯一提交点
  // ========================================================================

  private publishRecordPath(opHash: string): string {
    return path.join(STATE_DIR, 'publishes', `${opHash}.json`);
  }

  private assertPublishRecordShape(raw: unknown, opHash: string): PublishRecord {
    const r = raw as Partial<PublishRecord> | undefined;
    if (
      r === null || typeof r !== 'object' ||
      r.schema !== 1 || r.kind !== 'publish' ||
      typeof r.operationId !== 'string' ||
      typeof r.candidate !== 'string' || !SHA1_RE.test(r.candidate) ||
      typeof r.prefix !== 'string' ||
      (r.expectedPathRevision !== null && (typeof r.expectedPathRevision !== 'string' || !SHA1_RE.test(r.expectedPathRevision))) ||
      typeof r.metadataSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.metadataSha256) ||
      (r.status !== 'prepared' && r.status !== 'completed') ||
      !Array.isArray(r.attempts) ||
      !r.attempts.every(a => typeof a?.commit === 'string' && SHA1_RE.test(a.commit) && typeof a?.base === 'string' && SHA1_RE.test(a.base))
    ) {
      throw new VersionStoreError('record_corrupt', `publish record invalid: ${opHash}`);
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
    // metadata 原文持久化后必须与记录 hash 自洽（防记录篡改/半截写入被当作合法依据）
    if (r.metadata !== undefined && (typeof r.metadata !== 'string' || sha256Hex(r.metadata) !== r.metadataSha256)) {
      throw new VersionStoreError('record_corrupt', `publish record metadata inconsistent with its hash: ${opHash}`);
    }
    return r as PublishRecord;
  }

  /** 幂等键输入漂移 = 调用方契约错误（重放必须带相同输入；原文在场时逐字比较，不只比 hash） */
  private assertPublishInputsMatch(rec: PublishRecord, input: PublishInput, metadataSha: string): void {
    if (
      rec.operationId !== input.operationId ||
      rec.candidate !== input.candidate ||
      rec.prefix !== input.prefix ||
      rec.expectedPathRevision !== (input.expectedPathRevision as string | null) ||
      rec.metadataSha256 !== metadataSha ||
      (rec.metadata !== undefined && rec.metadata !== input.metadata)
    ) {
      throw new VersionStoreError('invalid_argument', 'operationId replayed with different publish inputs');
    }
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
    for (const { sha, body } of this.parseLogPairs(r.stdout)) {
      if (body.split('\n').includes(`operation-id: ${operationId}`)) {
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
      rec = this.assertPublishRecordShape(existing, opHash);
      this.assertPublishInputsMatch(rec, input, metadataSha);
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
        // 原文随 prepare 一并持久化：回执丢失/重启后依据仍可恢复，重放逐字校验
        metadata: input.metadata,
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

      // 提交消息携带 metadata hash：版本历史中的发布提交可与操作记录中的原文互证
      const commit = (await this.git([
        'commit-tree', newTree, '-p', head, '-m',
        `publish ${prefix}\n\noperation-id: ${input.operationId}\nmetadata-sha256: ${metadataSha}\n`,
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

  // ========================================================================
  // 固定版本读取 / 导出 / 恢复事实查询（phase 1918 Step D）
  // ========================================================================

  async readPublished(): Promise<VersionId> {
    return asVersionId((await this.git(['rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`])).stdout);
  }

  async pathRevision(version: VersionId, prefix: string): Promise<VersionId | null> {
    const v = await this.requireCommit(version, 'version');
    return this.pathRevisionOf(v, validatePrefix(prefix));
  }

  /** 解析 `git log --format=%H%x00%B%x00` 输出为 [sha, body] 对（body 不含 NUL） */
  private parseLogPairs(stdout: string): Array<{ sha: string; body: string }> {
    const parts = stdout.split('\0');
    const pairs: Array<{ sha: string; body: string }> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = parts[i].replace(/^\n+/, '');
      if (SHA1_RE.test(sha)) pairs.push({ sha, body: parts[i + 1] });
    }
    return pairs;
  }

  async history(prefix: string): Promise<VersionHistoryEntry[]> {
    const p = validatePrefix(prefix);
    const r = await this.gitExec(['log', '--first-parent', '--format=%H%x00%B%x00', PUBLISHED_REF, '--', p]);
    if (!r.ok) {
      throw new VersionStoreError('git_error', `git log failed: ${r.output.slice(0, 300)}`);
    }
    if (r.stdout === '') return [];
    return this.parseLogPairs(r.stdout).map(({ sha, body }) => {
      const opLine = body.split('\n').find(l => l.startsWith('operation-id: '));
      return {
        version: asVersionId(sha),
        operationId: opLine !== undefined ? opLine.slice('operation-id: '.length) : null,
      };
    });
  }

  /**
   * symlink 安全策略：拒绝绝对链接与逃逸导出根（prefix）的相对链接；
   * 根内相对链接允许并由 checkout-index 按原样物化。
   */
  private validateSymlinkTarget(entryPath: string, target: string, prefix: string): void {
    if (target.length === 0 || target.includes('\0') || path.posix.isAbsolute(target)) {
      throw new VersionStoreError('symlink_escape', `symlink ${entryPath} has forbidden target: ${target}`);
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
    if (resolved !== prefix && !resolved.startsWith(`${prefix}/`)) {
      throw new VersionStoreError('symlink_escape', `symlink ${entryPath} escapes export root: ${target}`);
    }
  }

  async exportVersion(version: VersionId, prefix: string, destination: string): Promise<void> {
    const v = await this.requireCommit(version, 'version');
    const p = validatePrefix(prefix);
    if (!path.isAbsolute(destination)) {
      throw new VersionStoreError('invalid_argument', `destination must be absolute: ${destination}`);
    }
    const dest = path.normalize(destination);
    const realRepoDir = path.dirname(this.realGitDir);
    // 同时按原始路径与 realpath 解析两种形式校验（macOS /var → /private/var 等别名）；
    // destination 不得位于版本库目录内（含 .git 与工作树投影区）
    const rawGitDir = path.join(path.resolve(this.repositoryDir), '.git');
    const forbidden = [realRepoDir, this.realGitDir, path.resolve(this.repositoryDir), rawGitDir];
    for (const root of forbidden) {
      if (dest === root || dest.startsWith(root + path.sep)) {
        throw new VersionStoreError('invalid_argument', 'destination must not be inside the repository directory');
      }
    }

    // 枚举条目：gitlink 拒绝；symlink 按已定义安全策略校验（不默默当普通文本）
    const lst = await this.gitExec(['ls-tree', '-r', '-z', v, '--', p]);
    if (!lst.ok) {
      throw new VersionStoreError('git_error', `git ls-tree failed: ${lst.output.slice(0, 300)}`);
    }
    const entries = lst.stdout.split('\0').filter(s => s.length > 0).map(line => {
      const m = line.match(/^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/);
      if (m === null) {
        throw new VersionStoreError('git_error', `unparseable ls-tree entry: ${line.slice(0, 200)}`);
      }
      return { mode: m[1], oid: m[3], path: m[4] };
    });
    if (entries.length === 0) {
      throw new VersionStoreError('not_found', `prefix ${p} does not exist at version ${v}`);
    }
    for (const entry of entries) {
      if (entry.mode === '160000') {
        emitSnapshotVersionExportFailed(this.audit, {
          dir: this.repositoryDir, reason: `gitlink entry cannot be materialized: ${entry.path}`, version: v, prefix: p, destination: dest,
        });
        throw new VersionStoreError('unsupported_entry', `gitlink entry cannot be materialized: ${entry.path}`);
      }
      if (entry.mode === '120000') {
        const blob = await this.git(['cat-file', 'blob', entry.oid], { raw: true });
        try {
          this.validateSymlinkTarget(entry.path, blob.stdout, p);
        } catch (e) {
          emitSnapshotVersionExportFailed(this.audit, {
            dir: this.repositoryDir, reason: (e as Error).message, version: v, prefix: p, destination: dest,
          });
          throw e;
        }
      }
    }

    // 私有 index 读固定 commit 子树并 checkout（不 checkout 共享根、不写全局 index）
    const sub = (await this.git(['rev-parse', `${v}:${p}`])).stdout;
    await this.fs.ensureDir(path.join(STATE_DIR, 'index'));
    const indexFile = path.join(
      this.realGitDir, 'version-store', 'index', `export-${sha256ShortHex(`${v}:${p}:${dest}`, 16)}.index`,
    );
    await this.git(['read-tree', sub], { indexFile });
    const checkout = await this.gitExec(['checkout-index', '-f', '-a', `--prefix=${dest}/`], { indexFile });
    if (!checkout.ok) {
      emitSnapshotVersionExportFailed(this.audit, {
        dir: this.repositoryDir, reason: checkout.output, version: v, prefix: p, destination: dest,
      });
      throw new VersionStoreError('git_error', `git checkout-index failed: ${checkout.output.slice(0, 300)}`);
    }
    emitSnapshotVersionExported(this.audit, { dir: this.repositoryDir, version: v, prefix: p, destination: dest });
  }

  async inspectOperation(operationId: string): Promise<OperationInspection> {
    validateOperationId(operationId);
    const workspaceId = `ws-${sha256ShortHex(`begin:${operationId}`, 24)}`;
    const wsRaw = await this.readRecord(this.workspaceRecordPath(workspaceId));
    if (wsRaw !== undefined) {
      const rec = this.assertWorkspaceRecord(wsRaw, workspaceId);
      return {
        kind: 'workspace',
        operationId: rec.operationId,
        workspaceId: rec.workspaceId,
        path: rec.path,
        branch: rec.branch,
        base: asVersionId(rec.base),
      };
    }
    const opHash = sha256Hex(`publish:${operationId}`);
    const pubRaw = await this.readRecord(this.publishRecordPath(opHash));
    if (pubRaw !== undefined) {
      const rec = this.assertPublishRecordShape(pubRaw, opHash);
      let result: PublishResult | undefined;
      if (rec.status === 'completed') {
        const res = rec.result as PublishRecordResult;
        result = res.kind === 'published'
          ? { kind: 'published', version: asVersionId(res.version) }
          : { kind: 'conflict', current: asVersionId(res.current), retainedCandidate: asVersionId(res.retainedCandidate) };
      }
      return {
        kind: 'publish',
        operationId: rec.operationId,
        status: rec.status,
        attempts: rec.attempts.map(a => a.commit),
        result,
        // 旧记录无原文：null 显式标记不可完整恢复，绝不伪造依据
        metadata: rec.metadata ?? null,
      };
    }
    return { kind: 'unknown', operationId };
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
