/**
 * Phase 1919 Step B: dispatch 技能版本服务（SkillVersions 实现）。
 *
 * 职责边界：
 * - 本服务 own：技能名校验、迁移/baseline、固定版本物化投影、import 与分支编辑
 *   事务（begin/submit/retry/cancel/status/history）的编排、迁移状态/技能清单/
 *   事务记录持久化（stateDir）。
 * - Snapshot VersionStore own：git 分支/提交/CAS/导出/操作记录（发布结果唯一权威；
 *   业务事务的 saved 未决状态经稳定 publishOperationId + inspectOperation 对账重建）。
 * - edit-store own：编辑事务记录的持久化/校验（editId 由 requestId 确定性派生）。
 * - 既有 registry own：SKILL.md 元信息解析与上下文格式化（本服务固定版本后调用）。
 *
 * 读取权威 = published ref + 不可变提交；库根工作区只是历史遗留投影，消费者
 * 一律读 stateDir 下按版本物化的投影（exportVersion 只读固定 commit，dirty
 * live 永远不会漏进读取路径）。
 */

import * as path from 'path';
import { copyDirAbsolute, isFileNotFound, type FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import { formatErr, newUuid, sha256Hex } from '../node-utils/index.js';
import {
  createVersionStore,
  VersionStoreError,
  type PublishResult,
  type VersionId,
  type VersionStore,
} from '../snapshot/index.js';
import { exec as defaultExec } from '../process-exec/index.js';
import { parseFrontmatterFrame } from '../messaging/index.js';
import { SkillSystem } from './registry.js';
import { SKILL_AUDIT_EVENTS } from './audit-events.js';
import {
  createSkillEditStore,
  SKILL_EDITS_DIR,
  skillEditId,
  type SkillEditRecord,
  type SkillEditStore,
} from './edit-store.js';
import {
  SkillVersionError,
  type BeginEditInput,
  type ExportSkillVersionInput,
  type ImportSkillInput,
  type PublishedSkill,
  type RetryEditInput,
  type SkillBasis,
  type SkillEditHandle,
  type SkillEditInfo,
  type SkillPublishResult,
  type SkillVersions,
  type SubmitEditResult,
} from './version-types.js';

/** dispatch 技能名：扁平 kebab 目录名（版本库顶层前缀，不含嵌套/命名空间段） */
const SKILL_DIR_NAME_PATTERN = /^[a-z0-9-]+$/;
/** publish metadata 上限与 Snapshot 对齐（basis 序列化后不得超过） */
const MAX_BASIS_CHARS = 16_000;

const STATE_FILE = 'state.json';
const IMPORTS_DIR = 'imports';
const PROJECTION_DIR = 'projection';
const PROJECTION_MANIFEST = 'projection-manifest.json';
const TMP_DIR = 'tmp';
const TRASH_DIR = 'trash';

/** 旧发布协议活动工件（在场 = 有未完成旧事务，必须先恢复，不能盲目 baseline） */
const LEGACY_STAGING_PREFIX = '.skill-staging-';
const LEGACY_TRASH_PREFIX = '.skill-trash-';
const LEGACY_SRCSNAP_PREFIX = '.skill-srcsnap-';
const LEGACY_PUBLISH_MARKER = '.skill-publishing';
const LEGACY_COMMIT_PROOF = '.skill-committed';
const LEGACY_CLAIM_SUFFIX = '.installing';

interface MigrationState {
  schema: 1;
  phase: 'migrating' | 'ready';
  migrationId: string;
  /** 迁移源树内容校验（逐文件 sha256 的聚合 hash；空树为 null） */
  contentSha256: string | null;
  at: string;
  skills: string[];
}

interface ServiceState {
  schema: 1;
  migration: MigrationState | null;
  /** 版本库顶层技能清单（baseline 建立，import 新技能追加；不参与删除） */
  skills: string[];
}

interface ProjectionManifest {
  version: string;
  skills: Record<string, string>;
}

/**
 * import 操作记录（服务级幂等键）：保存完成、发布未决时 prepared 落盘；
 * 发布结果确定后 completed。重放/重启以记录输入续作，返回首次操作事实
 * （发布成功后 published 已推进，不能靠重放 begin/save 重建原始基准）。
 */
interface ImportRecord {
  schema: 1;
  operationId: string;
  skill: string;
  /** basis 序列化原文（重放逐字比较，不只比 hash） */
  metadata: string;
  expected: string | null;
  candidate: string;
  status: 'prepared' | 'completed';
  result?: SkillPublishResult;
}

export interface SkillVersionsOptions {
  /** dispatch 版本库根绝对路径（独立 Git 根；亦为旧 live 目录） */
  repositoryDir: string;
  /** 候选编辑工作区 parent 绝对路径（clawspace 内隐藏目录） */
  workspaceParent: string;
  /** 服务状态目录绝对路径（clawspace 内隐藏目录） */
  stateDir: string;
  fsFactory(baseDir: string): FileSystem;
  audit: AuditLog;
  /** 测试/恢复判读缝：透传 VersionStore 的 git exec（故障注入、确定性并发屏障） */
  exec?: typeof defaultExec;
}

function validateSkillName(name: string): string {
  if (typeof name !== 'string' || !SKILL_DIR_NAME_PATTERN.test(name)) {
    throw new SkillVersionError(
      'invalid_argument',
      `skill name must match ${SKILL_DIR_NAME_PATTERN.source}: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

function validateBasis(basis: SkillBasis): string {
  if (
    basis === null || typeof basis !== 'object' ||
    typeof basis.actor !== 'string' || basis.actor.length === 0 ||
    typeof basis.reason !== 'string' || basis.reason.length === 0 ||
    !Array.isArray(basis.sourceRefs) || !basis.sourceRefs.every(r => typeof r === 'string')
  ) {
    throw new SkillVersionError('invalid_argument', 'basis must have non-empty actor/reason and string[] sourceRefs');
  }
  const metadata = JSON.stringify({ actor: basis.actor, reason: basis.reason, sourceRefs: basis.sourceRefs });
  if (metadata.length > MAX_BASIS_CHARS) {
    throw new SkillVersionError('invalid_argument', `basis exceeds ${MAX_BASIS_CHARS} chars when serialized`);
  }
  return metadata;
}

/** 迁移内容校验：逐文件 sha256 聚合（字节级，含 mode 位；symlink 按目标串） */
async function hashTree(rootFs: FileSystem, rel: string, lines: string[]): Promise<void> {
  const entries = await rootFs.list(rel, { includeDirs: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const p = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory) {
      await hashTree(rootFs, p, lines);
    } else {
      const st = await rootFs.stat(p);
      const buf = rootFs.readBytesSync(p, 0, st.size);
      lines.push(`${p}:${st.size}:${sha256Hex(buf.toString('base64'))}`);
    }
  }
}

export class SkillVersionService implements SkillVersions {
  private constructor(
    private readonly opts: SkillVersionsOptions,
    private readonly store: VersionStore,
    private readonly stateFs: FileSystem,
    private readonly editStore: SkillEditStore,
    private state: ServiceState,
  ) {}

  static async create(opts: SkillVersionsOptions): Promise<SkillVersionService> {
    if (!path.isAbsolute(opts.repositoryDir) || !path.isAbsolute(opts.workspaceParent) || !path.isAbsolute(opts.stateDir)) {
      throw new SkillVersionError('invalid_argument', 'repositoryDir/workspaceParent/stateDir must be absolute paths');
    }
    const stateFs = opts.fsFactory(opts.stateDir);
    await stateFs.ensureDir(IMPORTS_DIR);
    await stateFs.ensureDir(SKILL_EDITS_DIR);
    await stateFs.ensureDir(PROJECTION_DIR);
    await stateFs.ensureDir(TMP_DIR);
    await stateFs.ensureDir(TRASH_DIR);

    const repoFs = opts.fsFactory(opts.repositoryDir);
    await repoFs.ensureDir('.');

    const state = await SkillVersionService.openState(opts, stateFs, repoFs);
    const store = await createVersionStore({
      repositoryDir: opts.repositoryDir,
      workspaceParent: opts.workspaceParent,
      fs: repoFs,
      audit: opts.audit,
      exec: opts.exec,
    });
    const service = new SkillVersionService(
      opts,
      store,
      stateFs,
      createSkillEditStore(stateFs, opts.repositoryDir),
      state,
    );
    await service.finishBaselineIfNeeded();
    await service.syncProjection();
    return service;
  }

  // ========================================================================
  // 迁移 / baseline（一次性；旧 live 树 → 版本库；已有库只验证不覆盖）
  // ========================================================================

  private static async readState(stateFs: FileSystem): Promise<ServiceState | null> {
    let raw: string;
    try {
      raw = await stateFs.read(STATE_FILE);
    } catch (e) {
      if (isFileNotFound(e)) return null;
      throw e;
    }
    const parsed = JSON.parse(raw) as ServiceState;
    if (parsed === null || typeof parsed !== 'object' || parsed.schema !== 1 || !Array.isArray(parsed.skills)) {
      throw new SkillVersionError('baseline_failed', `corrupt version service state: ${STATE_FILE}`);
    }
    return parsed;
  }

  private async writeState(): Promise<void> {
    await this.stateFs.writeAtomic(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  private static async openState(
    opts: SkillVersionsOptions,
    stateFs: FileSystem,
    repoFs: FileSystem,
  ): Promise<ServiceState> {
    const hasGit = await repoFs.exists('.git');
    const existing = await SkillVersionService.readState(stateFs);
    if (existing !== null) {
      if (existing.migration !== null && existing.migration.phase === 'migrating') return existing; // 断点续迁（op id 确定性重放）
      if (!hasGit) {
        throw new SkillVersionError(
          'baseline_failed',
          'version service state exists but repository .git is missing; manual recovery required (not overwriting)',
        );
      }
      return existing; // 已有库只验证不覆盖
    }
    if (hasGit) {
      // 版本库在场但无本服务迁移状态：非本服务创建/状态丢失——loud 拒绝，不覆盖
      throw new SkillVersionError(
        'baseline_failed',
        'version repository .git exists without migration state; manual recovery required (not overwriting)',
      );
    }

    // ---- 全新 baseline：发现旧活动工件则阻断（不能绕过，先恢复旧事务） ----
    const blocked = await SkillVersionService.scanLegacyArtifacts(repoFs);
    if (blocked.length > 0) {
      opts.audit.write(
        SKILL_AUDIT_EVENTS.VERSION_MIGRATION_BLOCKED,
        `dir=${opts.repositoryDir}`,
        `evidence=${blocked.join(',')}`,
      );
      throw new SkillVersionError(
        'migration_blocked',
        `dispatch skill directory has in-flight legacy publish artifacts; recover or remove them before versioning: ${blocked.join(', ')}`,
        { evidence: blocked },
      );
    }

    // 盘点旧 live 树（非隐藏目录且含 SKILL.md）；内容校验随迁移记录持久化
    const skills: string[] = [];
    const entries = (await repoFs.list('.', { includeDirs: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.startsWith('.')) continue;
      validateSkillName(entry.name);
      if (await repoFs.exists(`${entry.name}/SKILL.md`)) {
        skills.push(entry.name);
      }
    }
    let contentSha256: string | null = null;
    if (skills.length > 0) {
      const lines: string[] = [];
      for (const name of skills) {
        await hashTree(repoFs, name, lines);
      }
      contentSha256 = sha256Hex(lines.join('\n'));
    }

    // 迁移备份：旧状态字节完整保存（可回滚），再建立版本库
    const migrationId = newUuid();
    if (skills.length > 0) {
      await copyDirAbsolute(opts.repositoryDir, path.join(opts.stateDir, `migration-backup-${migrationId}`));
    }
    const state: ServiceState = {
      schema: 1,
      migration: { schema: 1, phase: 'migrating', migrationId, contentSha256, at: new Date().toISOString(), skills },
      skills,
    };
    // 状态先于 createVersionStore 落盘：.git 在场 + 状态缺席的组合永远不出现
    await stateFs.writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
    return state;
  }

  /** 旧活动工件扫描：staging/trash/srcsnap 隐藏目录、claim、技能内 marker/proof */
  private static async scanLegacyArtifacts(repoFs: FileSystem): Promise<string[]> {
    const evidence: string[] = [];
    const entries = (await repoFs.list('.', { includeDirs: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name.startsWith(LEGACY_STAGING_PREFIX) ||
        entry.name.startsWith(LEGACY_TRASH_PREFIX) ||
        entry.name.startsWith(LEGACY_SRCSNAP_PREFIX) ||
        entry.name.endsWith(LEGACY_CLAIM_SUFFIX)
      ) {
        evidence.push(entry.name);
        continue;
      }
      if (entry.isDirectory && !entry.name.startsWith('.')) {
        if (await repoFs.exists(`${entry.name}/${LEGACY_PUBLISH_MARKER}`)) {
          evidence.push(`${entry.name}/${LEGACY_PUBLISH_MARKER}`);
        }
        if (await repoFs.exists(`${entry.name}/${LEGACY_COMMIT_PROOF}`)) {
          evidence.push(`${entry.name}/${LEGACY_COMMIT_PROOF}`);
        }
      }
    }
    return evidence;
  }

  /**
   * baseline 发布（幂等续作）：逐技能独立候选 + prefix 条件发布（候选只许触碰
   * 该技能子树）。operationId 由 migrationId 确定性派生——重放返回首次操作事实，
   * 不重建 baseline；已发布 prefix（路径基准非空）直接跳过，断点续迁不重来。
   */
  private async finishBaselineIfNeeded(): Promise<void> {
    const migration = this.state.migration;
    if (migration === null || migration.phase !== 'migrating') return;

    for (const name of migration.skills) {
      const published = await this.store.readPublished();
      if ((await this.store.pathRevision(published, name)) !== null) continue; // 此前断点已发布
      const ws = await this.store.begin({ operationId: `baseline-${migration.migrationId}-begin-${name}`, base: published });
      const dest = path.join(ws.path, name);
      await copyDirAbsolute(path.join(this.opts.repositoryDir, name), dest);
      const candidate = await this.store.save({
        workspaceId: ws.id,
        operationId: `baseline-${migration.migrationId}-save-${name}`,
        message: `baseline migration ${migration.migrationId}: ${name}`,
      });
      const result = await this.store.publish({
        operationId: `baseline-${migration.migrationId}-publish-${name}`,
        candidate,
        prefix: name,
        expectedPathRevision: null,
        metadata: JSON.stringify({ actor: 'skill-version-migration', reason: `baseline ${migration.migrationId}`, sourceRefs: [] }),
      });
      if (result.kind !== 'published') {
        throw new SkillVersionError(
          'baseline_failed',
          `baseline publish for "${name}" did not complete: ${result.kind}; repository preserved for recovery`,
        );
      }
    }
    migration.phase = 'ready';
    await this.writeState();
    this.opts.audit.write(
      SKILL_AUDIT_EVENTS.VERSION_BASELINE_CREATED,
      `dir=${this.opts.repositoryDir}`,
      `migration=${migration.migrationId}`,
      `skills=${migration.skills.length}`,
    );
  }

  // ========================================================================
  // 固定版本物化投影（exportVersion 只读固定 commit；dirty live 不漏入读取）
  // ========================================================================

  private projectionRel(name: string): string {
    return `${PROJECTION_DIR}/${name}`;
  }

  projectionAbs(name: string): string {
    return path.join(this.opts.stateDir, PROJECTION_DIR, name);
  }

  private async readProjectionManifest(): Promise<ProjectionManifest> {
    try {
      const raw = await this.stateFs.read(PROJECTION_MANIFEST);
      const parsed = JSON.parse(raw) as ProjectionManifest;
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string' && parsed.skills !== null) {
        return parsed;
      }
    } catch (e) {
      if (!isFileNotFound(e)) {
        this.opts.audit.write(SKILL_AUDIT_EVENTS.VERSION_SYNC_FAILED, `dir=${this.opts.repositoryDir}`, `reason=manifest_${formatErr(e)}`);
      }
    }
    return { version: '', skills: {} };
  }

  /**
   * 投影同步：published 版本变化时逐技能重物化。投影是服务私有派生物
   * （清单按 published 版本判新）；导出/落位失败保留旧投影并 audit，
   * 清单不推进（下次重试），绝不把 live 工作区字节当已发布内容。
   */
  private async syncProjection(): Promise<void> {
    const published = await this.store.readPublished();
    const manifest = await this.readProjectionManifest();
    if (manifest.version === (published as string)) return;

    for (const name of this.state.skills) {
      const rev = await this.store.pathRevision(published, name);
      if (rev === null) continue; // 尚未发布（baseline 中途），保持旧投影
      if (manifest.skills[name] === (rev as string)) continue;
      const tmpRel = `${TMP_DIR}/${name}-${newUuid()}`;
      const tmpAbs = path.join(this.opts.stateDir, tmpRel);
      try {
        await this.store.exportVersion(published, name, tmpAbs);
        // swap：旧投影入 trash → 新投影落位 → 清理 trash（rename 短窗，崩溃留 trash 证据）
        const liveRel = this.projectionRel(name);
        if (await this.stateFs.exists(liveRel)) {
          const trashRel = `${TRASH_DIR}/${name}-${newUuid()}`;
          await this.stateFs.moveDir(liveRel, trashRel);
          try {
            await this.stateFs.moveDir(tmpRel, liveRel);
          } catch (e) {
            await this.stateFs.moveDir(trashRel, liveRel).catch(() => undefined); // 恢复旧投影
            throw e;
          }
          await this.stateFs.removeDir(trashRel).catch(() => undefined); // 残留 trash 下次收敛
        } else {
          await this.stateFs.moveDir(tmpRel, liveRel);
        }
        manifest.skills[name] = rev as string;
      } catch (e) {
        this.opts.audit.write(
          SKILL_AUDIT_EVENTS.VERSION_SYNC_FAILED,
          `dir=${this.opts.repositoryDir}`,
          `skill=${name}`,
          `reason=${formatErr(e)}`,
        );
        await this.stateFs.removeDir(tmpRel).catch(() => undefined);
        return; // 清单不推进：下次重试；已发布事实不受影响
      }
    }
    manifest.version = published as string;
    await this.stateFs.writeAtomic(PROJECTION_MANIFEST, JSON.stringify(manifest, null, 2));
  }

  // ========================================================================
  // 固定版本读取（全部消费者的唯一入口）
  // ========================================================================

  async readPublished(name: string): Promise<PublishedSkill> {
    validateSkillName(name);
    await this.syncProjection();
    const manifest = await this.readProjectionManifest();
    const rev = manifest.skills[name];
    if (rev === undefined || !(await this.stateFs.exists(`${this.projectionRel(name)}/SKILL.md`))) {
      throw new SkillVersionError('not_found', `dispatch skill "${name}" has no published version`);
    }
    return { name, sourceVersion: rev, materializedPath: this.projectionAbs(name) };
  }

  async loadPublished(name: string): Promise<string> {
    const publishedSkill = await this.readPublished(name);
    return this.stateFs.read(`${PROJECTION_DIR}/${publishedSkill.name}/SKILL.md`);
  }

  async formatPublishedForContext(): Promise<string> {
    await this.syncProjection();
    // 元信息解析/格式化唯一 owner = 既有 registry；投影目录只含已发布技能
    const registry = new SkillSystem(this.opts.fsFactory(path.join(this.opts.stateDir, PROJECTION_DIR)), '.', this.opts.audit);
    await registry.loadAll();
    return registry.formatForContext();
  }

  // ========================================================================
  // import：分支保存 + 按技能路径条件发布（不覆盖他人已发布版本）
  // ========================================================================

  private importRecordPath(operationId: string): string {
    return `${IMPORTS_DIR}/${sha256Hex(`import:${operationId}`)}.json`;
  }

  private async readImportRecord(operationId: string): Promise<ImportRecord | null> {
    let raw: string;
    try {
      raw = await this.stateFs.read(this.importRecordPath(operationId));
    } catch (e) {
      if (isFileNotFound(e)) return null;
      throw e;
    }
    const r = JSON.parse(raw) as ImportRecord;
    const res = r.result as Partial<SkillPublishResult> | undefined;
    const validResult = res === undefined || (res !== null && typeof res === 'object' &&
      ((res.kind === 'published' && typeof (res as { version?: unknown }).version === 'string') ||
        (res.kind === 'conflict' && typeof (res as { current?: unknown }).current === 'string' &&
          typeof (res as { retainedCandidate?: unknown }).retainedCandidate === 'string')));
    if (
      r === null || typeof r !== 'object' || r.schema !== 1 ||
      typeof r.operationId !== 'string' || typeof r.skill !== 'string' ||
      typeof r.metadata !== 'string' || typeof r.candidate !== 'string' ||
      (r.expected !== null && typeof r.expected !== 'string') ||
      (r.status !== 'prepared' && r.status !== 'completed') ||
      (r.status === 'completed' && r.result === undefined) || !validResult
    ) {
      throw new SkillVersionError('store_error', `corrupt import record for operationId: ${operationId}`);
    }
    return r;
  }

  private async writeImportRecord(record: ImportRecord): Promise<void> {
    await this.stateFs.writeAtomic(this.importRecordPath(record.operationId), JSON.stringify(record, null, 2));
  }

  async importSkill(input: ImportSkillInput): Promise<SkillPublishResult> {
    if (typeof input.operationId !== 'string' || input.operationId.length === 0) {
      throw new SkillVersionError('invalid_argument', 'operationId must be a non-empty string');
    }
    const metadata = validateBasis(input.basis);
    if (!path.isAbsolute(input.source)) {
      throw new SkillVersionError('invalid_argument', `source must be an absolute path: ${input.source}`);
    }
    const name = validateSkillName(input.name);
    const sourceFs = this.opts.fsFactory(input.source);
    if (!(await sourceFs.exists('SKILL.md'))) {
      throw new SkillVersionError('invalid_argument', `source has no SKILL.md: ${input.source}`);
    }
    if (await sourceFs.exists('.git')) {
      // 版本库元数据绝不作为技能 payload 进入候选（反向：不把 .git 当 payload）
      throw new SkillVersionError('invalid_argument', `source must not contain a .git entry: ${input.source}`);
    }

    // 服务级幂等：记录在场 → 逐字校验输入未漂移（技能名/依据原文）→ 重放首次
    // 操作事实或以记录输入续作未决发布（store 记录亦幂等，双重保护）
    const existing = await this.readImportRecord(input.operationId);
    if (existing !== null) {
      if (existing.operationId !== input.operationId || existing.skill !== name || existing.metadata !== metadata) {
        throw new SkillVersionError('invalid_argument', 'operationId replayed with different import inputs');
      }
      if (existing.status === 'completed') {
        await this.syncProjection(); // 完成记录与投影推进间的崩溃窗口自愈
        return existing.result as SkillPublishResult;
      }
      const resumed = await this.store.publish({
        operationId: input.operationId,
        candidate: existing.candidate as VersionId,
        prefix: name,
        expectedPathRevision: existing.expected as VersionId | null,
        metadata,
      });
      return this.finalizeImport(existing, resumed);
    }

    const published = await this.store.readPublished();
    const expected = await this.store.pathRevision(published, name);
    const ws = await this.store.begin({ operationId: `${input.operationId}-begin`, base: published });
    const dest = path.join(ws.path, name);
    // 替换工作区内同名技能子树（候选只触碰该 prefix；source 只读，绝不改源）
    await this.opts.fsFactory(ws.path).removeDir(name).catch((e: unknown) => {
      if (!isFileNotFound(e)) throw e;
    });
    await copyDirAbsolute(input.source, dest);
    const candidate = await this.store.save({
      workspaceId: ws.id,
      operationId: `${input.operationId}-save`,
      message: `import ${name}\n\n${input.basis.reason}`,
    });

    // 保存完成、发布未决：prepared 先落盘（重放不依赖 begin/save 基准重建）
    const record: ImportRecord = {
      schema: 1,
      operationId: input.operationId,
      skill: name,
      metadata,
      expected: expected as string | null,
      candidate: candidate as string,
      status: 'prepared',
    };
    await this.writeImportRecord(record);

    const result = await this.store.publish({
      operationId: input.operationId,
      candidate,
      prefix: name,
      expectedPathRevision: expected,
      metadata,
    });
    return this.finalizeImport(record, result);
  }

  /** 发布结果落定：completed 记录 + 技能清单/审计/投影推进；busy 保持 prepared 可续作 */
  private async finalizeImport(record: ImportRecord, result: PublishResult): Promise<SkillPublishResult> {
    const name = record.skill;
    if (result.kind === 'published') {
      if (!this.state.skills.includes(name)) {
        this.state.skills.push(name);
        this.state.skills.sort();
        await this.writeState();
      }
      record.status = 'completed';
      record.result = { kind: 'published', version: result.version as string };
      await this.writeImportRecord(record);
      this.opts.audit.write(
        SKILL_AUDIT_EVENTS.VERSION_IMPORT_PUBLISHED,
        `dir=${this.opts.repositoryDir}`,
        `skill=${name}`,
        `version=${result.version}`,
        `operationId=${record.operationId}`,
      );
      await this.syncProjection();
      return record.result;
    }
    if (result.kind === 'conflict') {
      record.status = 'completed';
      record.result = {
        kind: 'conflict',
        current: result.current as string,
        retainedCandidate: result.retainedCandidate as string,
      };
      await this.writeImportRecord(record);
      this.opts.audit.write(
        SKILL_AUDIT_EVENTS.VERSION_IMPORT_CONFLICT,
        `dir=${this.opts.repositoryDir}`,
        `skill=${name}`,
        `current=${result.current}`,
        `candidate=${result.retainedCandidate}`,
        `operationId=${record.operationId}`,
      );
      return record.result;
    }
    // busy：CAS 有界重试耗尽，不伪造语义冲突；记录保持 prepared，重试续作
    return { kind: 'busy', operationId: result.operationId };
  }

  // ========================================================================
  // Phase 1919 Step C：技能分支编辑事务
  // （业务事务记录 own 状态机；发布权威唯一 = Snapshot 操作记录，
  //   saved 未决经稳定 publishOperationId + inspectOperation 对账重建）
  // ========================================================================

  private async requireEdit(editId: string): Promise<SkillEditRecord> {
    const record = await this.editStore.load(editId);
    if (record === null) {
      throw new SkillVersionError('not_found', `no such skill edit: ${editId}`);
    }
    return record;
  }

  private toInfo(record: SkillEditRecord): SkillEditInfo {
    return {
      editId: record.editId,
      requestId: record.requestId,
      skillName: record.skillName,
      base: record.base,
      basePathRevision: record.basePathRevision,
      candidate: record.candidate,
      status: record.status,
      parentEditId: record.parentEditId,
      publishOperationId: record.publishOperationId,
      version: record.version,
      current: record.current,
      basis: JSON.parse(record.metadata) as SkillBasis,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toHandle(record: SkillEditRecord): SkillEditHandle {
    if (record.workspaceId === null) {
      throw new SkillVersionError('store_error', `skill edit ${record.editId} has no workspace (status=${record.status})`);
    }
    return {
      editId: record.editId,
      skillName: record.skillName,
      path: path.join(this.opts.workspaceParent, record.workspaceId, record.skillName),
      base: record.base,
      basePathRevision: record.basePathRevision,
    };
  }

  /** 开工作区分支（幂等：operationId 确定性派生，store.begin 重放返回首次工作区） */
  private async openEditWorkspace(record: SkillEditRecord): Promise<void> {
    const ws = await this.store.begin({ operationId: `edit-begin-${record.editId}`, base: record.base as VersionId });
    record.workspaceId = ws.id;
    record.status = 'editing';
    record.updatedAt = new Date().toISOString();
    await this.editStore.save(record);
  }

  /**
   * begin 编排（fresh + 重放续作共用）：记录先于工作区落盘（preparing 可重建）；
   * 同 requestId 重放逐字校验输入后返回首次事实；preparing 中断记录补齐工作区。
   */
  private async beginEditInternal(
    input: BeginEditInput,
    metadata: string,
    parentEditId: string | null,
  ): Promise<SkillEditHandle> {
    const editId = skillEditId(input.requestId);
    const existing = await this.editStore.load(editId);
    if (existing !== null) {
      if (
        existing.requestId !== input.requestId ||
        existing.skillName !== input.skillName ||
        existing.metadata !== metadata ||
        existing.parentEditId !== parentEditId
      ) {
        throw new SkillVersionError('invalid_argument', 'requestId replayed with different edit inputs');
      }
      if (existing.workspaceId === null) {
        await this.openEditWorkspace(existing); // preparing 中断续作
      }
      return this.toHandle(existing);
    }

    const published = await this.store.readPublished();
    const basePathRevision = await this.store.pathRevision(published, input.skillName);
    const now = new Date().toISOString();
    const record: SkillEditRecord = {
      schema: 1,
      editId,
      requestId: input.requestId,
      skillName: input.skillName,
      repositoryDir: this.opts.repositoryDir,
      metadata,
      base: published as string,
      basePathRevision: basePathRevision as string | null,
      workspaceId: null,
      candidate: null,
      status: 'preparing',
      parentEditId,
      publishOperationId: null,
      version: null,
      current: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.editStore.save(record); // 记录先于工作区：中断可重建
    await this.openEditWorkspace(record);
    if (parentEditId !== null) {
      this.opts.audit.write(
        SKILL_AUDIT_EVENTS.VERSION_EDIT_RETRIED,
        `dir=${this.opts.repositoryDir}`,
        `skill=${record.skillName}`,
        `editId=${record.editId}`,
        `parent=${parentEditId}`,
        `base=${record.base}`,
      );
    } else {
      this.opts.audit.write(
        SKILL_AUDIT_EVENTS.VERSION_EDIT_BEGAN,
        `dir=${this.opts.repositoryDir}`,
        `skill=${record.skillName}`,
        `editId=${record.editId}`,
        `base=${record.base}`,
      );
    }
    return this.toHandle(record);
  }

  async beginEdit(input: BeginEditInput): Promise<SkillEditHandle> {
    if (typeof input.requestId !== 'string' || input.requestId.length === 0) {
      throw new SkillVersionError('invalid_argument', 'requestId must be a non-empty string');
    }
    const metadata = validateBasis(input.basis);
    const skillName = validateSkillName(input.skillName);
    return this.beginEditInternal({ ...input, skillName }, metadata, null);
  }

  /**
   * 候选 SKILL.md 校验（候选字节权威：exportVersion 只读固定候选 commit，
   * 不判读可变工作区）。缺失/解析失败 typed 拒绝 + audit，候选保留。
   */
  private async validateCandidateSkill(record: SkillEditRecord): Promise<void> {
    const tmpRel = `${TMP_DIR}/validate-${record.editId}-${newUuid()}`;
    const tmpAbs = path.join(this.opts.stateDir, tmpRel);
    let content: string | null = null;
    let failReason: string | null = null;
    try {
      await this.store.exportVersion(record.candidate as VersionId, record.skillName, tmpAbs);
      content = await this.opts.fsFactory(tmpAbs).read('SKILL.md');
    } catch (e) {
      // 捕获为判定事实：下方统一 audit + typed 拒绝（候选保留），不吞咽
      failReason = `candidate for skill "${record.skillName}" has no readable SKILL.md: ${formatErr(e)}`;
    }
    await this.stateFs.removeDir(tmpRel).catch(() => undefined);

    if (failReason === null) {
      try {
        parseFrontmatterFrame(content as string, { eofTolerant: true });
      } catch (e) {
        // 同上：解析失败判定事实，下方统一 audit + typed 拒绝
        failReason = `candidate SKILL.md for skill "${record.skillName}" failed to parse: ${formatErr(e)}`;
      }
    }
    if (failReason !== null) {
      this.opts.audit.write(
        SKILL_AUDIT_EVENTS.VERSION_EDIT_VALIDATION_FAILED,
        `dir=${this.opts.repositoryDir}`,
        `skill=${record.skillName}`,
        `editId=${record.editId}`,
        `candidate=${record.candidate}`,
        `reason=${failReason}`,
      );
      throw new SkillVersionError('invalid_argument', `${failReason} (candidate ${record.candidate} retained)`);
    }
  }

  async submitEdit(editId: string): Promise<SubmitEditResult> {
    const record = await this.requireEdit(editId);
    // 终态重放：返回首次发布事实（重启后亦不重复发布）
    if (record.status === 'published') {
      return { kind: 'published', editId, version: record.version as string };
    }
    if (record.status === 'conflict') {
      return {
        kind: 'conflict',
        editId,
        base: record.base,
        current: record.current as string,
        candidate: record.candidate as string,
      };
    }
    if (record.status === 'cancelled') {
      throw new SkillVersionError('invalid_argument', `skill edit ${editId} is cancelled`);
    }
    if (record.workspaceId === null) {
      throw new SkillVersionError(
        'invalid_argument',
        `skill edit ${editId} has no workspace (begin did not complete); re-run beginEdit with the same requestId`,
      );
    }

    // 1. 保存候选（幂等：候选已持久绝不重新 save）
    if (record.candidate === null) {
      const candidate = await this.store.save({
        workspaceId: record.workspaceId,
        operationId: `edit-save-${record.editId}`,
        message: `edit ${record.skillName}\n\n${(JSON.parse(record.metadata) as SkillBasis).reason}`,
      });
      record.candidate = candidate as string;
      record.status = 'saved';
      record.updatedAt = new Date().toISOString();
      await this.editStore.save(record);
    }

    // 2. 候选校验（范围违规在发布侧 typed 拒绝；两处失败候选都保留）
    await this.validateCandidateSkill(record);

    // 3. 条件发布（稳定 publishOperationId 先落盘：业务状态可经 Snapshot 记录重建）
    if (record.publishOperationId === null) {
      record.publishOperationId = `edit-publish-${record.editId}`;
      record.updatedAt = new Date().toISOString();
      await this.editStore.save(record);
    }
    let result: PublishResult;
    try {
      result = await this.store.publish({
        operationId: record.publishOperationId,
        candidate: record.candidate as VersionId,
        prefix: record.skillName,
        expectedPathRevision: record.basePathRevision as VersionId | null,
        metadata: record.metadata,
      });
    } catch (e) {
      if (e instanceof VersionStoreError && e.kind === 'candidate_out_of_scope') {
        const reason = `candidate for skill "${record.skillName}" modifies paths outside its subtree: ${e.message}`;
        this.opts.audit.write(
          SKILL_AUDIT_EVENTS.VERSION_EDIT_VALIDATION_FAILED,
          `dir=${this.opts.repositoryDir}`,
          `skill=${record.skillName}`,
          `editId=${record.editId}`,
          `candidate=${record.candidate}`,
          `reason=${reason}`,
        );
        throw new SkillVersionError('invalid_argument', `${reason} (candidate ${record.candidate} retained)`);
      }
      throw e;
    }
    return this.finalizeEdit(record, result);
  }

  /** 发布结果落定：事务记录迁移 + 技能清单/审计/投影推进；busy 保持 saved 待重试 */
  private async finalizeEdit(record: SkillEditRecord, result: PublishResult): Promise<SubmitEditResult> {
    if (result.kind === 'published') {
      await this.markEditPublished(record, result.version as string);
      return { kind: 'published', editId: record.editId, version: record.version as string };
    }
    if (result.kind === 'conflict') {
      await this.markEditConflict(record, result.current as string);
      return {
        kind: 'conflict',
        editId: record.editId,
        base: record.base,
        current: record.current as string,
        candidate: record.candidate as string,
      };
    }
    // busy：CAS 有界重试耗尽——持久呈现为待重试（saved + publishOperationId 在场，
    // 候选保留），绝不伪装成语义冲突；同 editId 重提续作
    return { kind: 'busy', editId: record.editId, operationId: result.operationId };
  }

  private async markEditPublished(record: SkillEditRecord, version: string): Promise<void> {
    record.status = 'published';
    record.version = version;
    record.updatedAt = new Date().toISOString();
    if (!this.state.skills.includes(record.skillName)) {
      this.state.skills.push(record.skillName);
      this.state.skills.sort();
      await this.writeState();
    }
    await this.editStore.save(record);
    this.opts.audit.write(
      SKILL_AUDIT_EVENTS.VERSION_EDIT_PUBLISHED,
      `dir=${this.opts.repositoryDir}`,
      `skill=${record.skillName}`,
      `editId=${record.editId}`,
      `version=${version}`,
    );
    await this.syncProjection();
  }

  private async markEditConflict(record: SkillEditRecord, current: string): Promise<void> {
    record.status = 'conflict';
    record.current = current;
    record.updatedAt = new Date().toISOString();
    await this.editStore.save(record);
    this.opts.audit.write(
      SKILL_AUDIT_EVENTS.VERSION_EDIT_CONFLICT,
      `dir=${this.opts.repositoryDir}`,
      `skill=${record.skillName}`,
      `editId=${record.editId}`,
      `current=${current}`,
      `candidate=${record.candidate}`,
    );
  }

  async retryEdit(input: RetryEditInput): Promise<SkillEditHandle> {
    if (typeof input.requestId !== 'string' || input.requestId.length === 0) {
      throw new SkillVersionError('invalid_argument', 'requestId must be a non-empty string');
    }
    const old = await this.requireEdit(input.editId);
    if (old.status !== 'conflict') {
      throw new SkillVersionError(
        'invalid_argument',
        `only conflict edits can be retried: ${input.editId} (status=${old.status})`,
      );
    }
    // 从最新 published 新建分支并链接旧编辑；依据沿用旧记录原文。
    // 绝不 reset 原分支/自动 merge/强推旧候选字节——新工作区只含已发布内容。
    return this.beginEditInternal(
      { skillName: old.skillName, requestId: input.requestId, basis: JSON.parse(old.metadata) as SkillBasis },
      old.metadata,
      old.editId,
    );
  }

  async cancelEdit(editId: string): Promise<SkillEditInfo> {
    const record = await this.requireEdit(editId);
    if (record.status === 'published' || record.status === 'conflict') {
      throw new SkillVersionError('invalid_argument', `skill edit ${editId} already ${record.status}`);
    }
    if (record.status !== 'cancelled') {
      // 先保存可保存内容再登记；保存失败 loud 拒绝，工作区明确保留
      if (record.status === 'editing' && record.workspaceId !== null && record.candidate === null) {
        let candidate: VersionId;
        try {
          candidate = await this.store.save({
            workspaceId: record.workspaceId,
            operationId: `edit-save-${record.editId}`,
            message: `cancel edit ${record.skillName}`,
          });
        } catch (e) {
          throw new SkillVersionError(
            'store_error',
            `failed to save workspace before cancel; workspace retained at ${path.join(this.opts.workspaceParent, record.workspaceId)}: ${formatErr(e)}`,
          );
        }
        record.candidate = candidate as string;
      }
      record.status = 'cancelled';
      record.updatedAt = new Date().toISOString();
      await this.editStore.save(record);
      this.opts.audit.write(
        SKILL_AUDIT_EVENTS.VERSION_EDIT_CANCELLED,
        `dir=${this.opts.repositoryDir}`,
        `skill=${record.skillName}`,
        `editId=${record.editId}`,
        `candidate=${record.candidate}`,
      );
    }
    return this.toInfo(record);
  }

  /**
   * 对账：saved + publishOperationId（busy/崩溃窗口）经稳定幂等键查询 Snapshot
   * 操作记录，以发布权威结果重建业务状态（completed published/conflict → 迁移
   * 事务记录）；prepared/unknown 保持 saved 待重试，不误报。
   */
  private async reconcileEdit(record: SkillEditRecord): Promise<void> {
    if (record.status !== 'saved' || record.publishOperationId === null) return;
    const insp = await this.store.inspectOperation(record.publishOperationId);
    if (insp.kind !== 'publish' || insp.status !== 'completed' || insp.result === undefined) return;
    if (insp.result.kind === 'published') {
      await this.markEditPublished(record, insp.result.version as string);
    } else if (insp.result.kind === 'conflict') {
      await this.markEditConflict(record, insp.result.current as string);
    }
  }

  async editStatus(editId: string): Promise<SkillEditInfo> {
    const record = await this.requireEdit(editId);
    await this.reconcileEdit(record);
    return this.toInfo(record);
  }

  async editHistory(skillName?: string): Promise<readonly SkillEditInfo[]> {
    if (skillName !== undefined) validateSkillName(skillName);
    const records = await this.editStore.list();
    const infos: SkillEditInfo[] = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (skillName !== undefined && record.skillName !== skillName) continue;
      await this.reconcileEdit(record);
      infos.push(this.toInfo(record));
    }
    return infos;
  }

  // ========================================================================
  // Phase 1919 Step F：安装来源版本固定——按已发布 commit 导出技能子树
  // ========================================================================

  /**
   * 安装 pinning 导出：commit 缺失/损坏/子树缺席 typed 失败（fail-closed，
   * 绝不回退 live 字节）；destination 独占性/库外约束由 Snapshot owner 强制。
   */
  async exportSkillVersion(input: ExportSkillVersionInput): Promise<void> {
    const name = validateSkillName(input.name);
    if (!/^[0-9a-f]{40}$/.test(input.version)) {
      throw new SkillVersionError('invalid_argument', `version must be a 40-hex commit id: ${input.version}`);
    }
    if (!path.isAbsolute(input.destination)) {
      throw new SkillVersionError('invalid_argument', `destination must be an absolute path: ${input.destination}`);
    }
    try {
      await this.store.exportVersion(input.version as VersionId, name, input.destination);
    } catch (e) {
      if (e instanceof VersionStoreError) {
        const kind = e.kind === 'not_found' ? 'not_found'
          : e.kind === 'invalid_argument' ? 'invalid_argument'
            : 'store_error';
        throw new SkillVersionError(
          kind,
          `export skill "${name}" at version ${input.version} failed: ${e.message}`,
        );
      }
      throw e;
    }
  }
}

/** Phase 1919 Step B：构造并完成迁移/投影同步的服务工厂（失败 loud，不降级为 live 读取）。 */
export async function createSkillVersions(opts: SkillVersionsOptions): Promise<SkillVersions> {
  return SkillVersionService.create(opts);
}
