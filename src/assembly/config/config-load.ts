/**
 * Assembly config load module
 * phase 298: V12 (b) real-治、wrapper 反向迁 foundation → assembly
 *
 * Owns: root config wrapper (load/save/exists/patch) + LLM merge
 * Generic yaml CRUD delegates to L2a ConfigStore barrel (phase 1297 Step A; loader moved out of assembly)
 * Failure mapping: ConfigStore typed code → global/claw 业务文案 (phase 1297 Step B)
 * path primitive: getGlobalConfigPath in ./global-config-path.ts (phase 704)
 */
import * as path from 'path';
import {
  createStoredGlobalConfigSchema,
  getClawConfigSchema,
  type ClawGlobalConfig,
  type ClawGlobalConfigInput,
  type ClawConfig,
} from './compose-config.js';
import {
  readYamlDocument,
  loadYamlConfig,
  writeYamlConfig,
  writeYamlConfigExclusive,
  patchYamlConfig,
  withYamlConfigLock,
  configExists,
  isConfigStoreError,
  type ConfigStoreError,
} from '../../foundation/config-store/index.js';
import { getGlobalConfigPath } from './global-config-path.js';
import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import {
  createLLMConfiguration,
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
  llmConfigurationSourceDigest,
  assertNoLegacyPlaintextApiKey,
  migrateLegacyApiKeysAtPath,
  recordLLMMigrationSourceCleanup,
  recordLLMMigrationSourceCleanupFailure,
  LLMConfigurationMigrationError,
  type SharedLLMInput,
  type LLMGlobalConfigView,
  type LLMClawConfigView,
  type CredentialSource,
  type CredentialFact,
} from '../../core/llm-configuration/index.js';
import {
  createAuthenticationSetup,
  type ResolvedAuthenticationSetupCredential,
} from '../../core/llm-configuration/setup.js';
import {
  loadWorkspaceAuditConfig,
  initWorkspaceAuditConfig,
  publishAuditLayout,
} from '../../foundation/audit/index.js';
import {
  loadWorkspaceWatchdogConfig,
  initWorkspaceWatchdogConfig,
  publishWatchdogLayout,
} from '../../watchdog/index.js';
import type { AtomicWriteResult, FileSystem } from '../../foundation/fs/index.js';
import { newUuid, sha256Hex } from '../../foundation/node-utils/index.js';

/**
 * Phase 2206 Step B：`${VAR}` 解析注入 —— workspace Credentials owner 分层解析
 * （进程环境 > workspace 凭据文件 > workspace 根 .env）。
 * owner 无状态不缓存，每次 load 新建即等价「每次 loadYamlConfig 调用注入」。
 * permissions/io_error 等 CredentialsError loud 向上传播（ConfigStore 只包装
 * env 缺席为 missing_env，其余错误不吞）。非法 ref 不降级到另一套读取。
 */
function makeEnvVarResolver(deps: { fsFactory: (baseDir: string) => FileSystem }): (name: string) => string | undefined {
  const authentication = createAuthenticationSetup({ fsFactory: deps.fsFactory });
  return (name) => authentication.resolveSync(name)?.accessToken;
}

/**
 * ConfigStore typed failure → Assembly 业务文案（phase 1297 Step B）。
 * exhaustive switch：新增 ConfigStoreErrorCode 时 default 分支 never 赋值触发编译错误。
 * 对外 message 与 cause 链保持 phase 1297 前兼容：
 * - global missing 固定为 `Global config not found.`；
 * - read/YAML 失败原文重抛（包一层带 cause）；
 * - env/schema 仅替换 global/claw 前缀。
 */
function mapConfigStoreError(err: ConfigStoreError, kind: 'global' | 'claw'): Error {
  switch (err.code) {
    case 'not_found':
      // claw 路径先经 configExists 检查；竞态下原样传播 generic 文案（同旧行为）。
      return kind === 'global'
        ? new Error('Global config not found.', { cause: err })
        : err;
    case 'read_failed':
    case 'invalid_yaml':
      return new Error(err.message, { cause: err });
    case 'missing_env':
      return new Error(
        err.message.replace('Invalid config (env var):', `Invalid ${kind} config (env var):`),
        { cause: err },
      );
    case 'invalid_schema':
      return new Error(
        err.message.replace('Invalid config:', `Invalid ${kind} config:`),
        { cause: err },
      );
    case 'expected_object':
      // load 路径不产生（仅 patch root-shape）；原样传播。
      return err;
    case 'already_exists':
      // 由 saveGlobalConfigExclusive 自行映射为 GlobalConfigAlreadyExistsError；
      // 其余路径不产生该 code，原样传播。
      return err;
    case 'lock_timeout':
      return new Error(
        'Global config is busy: another process is updating it (lock timeout). Retry the command.',
        { cause: err },
      );
    case 'lock_indeterminate':
      // 回收抢到新代且恢复受阻 / corpse 不可读 —— 证据已保留，需人工核查
      return new Error(
        `Global config lock state is indeterminate and requires manual recovery: ${err.message}`,
        { cause: err },
      );
    case 'lock_lost':
      // 锁在 mutation 期间被替换/消失 —— mutation 结果需人工核实
      return new Error(
        `Global config lock was lost during mutation: ${err.message}`,
        { cause: err },
      );
    default: {
      const exhaustive: never = err.code;
      throw new Error(`Unhandled ConfigStoreError code: ${String(exhaustive)}`);
    }
  }
}

/** 保留 root config 的公开形状，同时让 LLM snapshot 消费同次读取的 raw/revision。 */
function withLLMView(
  stored: Omit<ClawGlobalConfig, 'llm'> & { llm?: unknown },
  view: LLMGlobalConfigView,
): ClawGlobalConfig {
  const result = { ...stored, llm: view.llm };
  for (const key of ['raw', 'revision', 'workspaceRoot', 'credentialSources', 'credentialFacts'] as const) {
    if (view[key] !== undefined) Object.defineProperty(result, key, { value: view[key], enumerable: false });
  }
  return result as ClawGlobalConfig;
}

function rootMigrationId(source: SharedLLMInput): string {
  return `root-${llmConfigurationSourceDigest(source).slice(0, 24)}`;
}

export function readRawRootLLM(deps: { fsFactory: (baseDir: string) => FileSystem }): SharedLLMInput | undefined {
  const raw = readYamlDocument(deps, getGlobalConfigPath());
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>).llm as SharedLLMInput | undefined;
}

/** 目标确认后才按 sourceDigest 清源；目标损坏/冲突时绝不回退旧段。 */
function migrateRootLLM(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  source: SharedLLMInput,
): void {
  const store = createLLMConfigurationDocumentStore(deps);
  const migrationId = rootMigrationId(source);
  const result = store.createFromSource(source, migrationId);
  if (result.kind !== 'durable') {
    throw new LLMConfigurationMigrationError(
      `LLM migration target write was not confirmed durable; source preserved: ${migrationId}`,
      migrationId,
    );
  }
  const sourceDigest = llmConfigurationSourceDigest(source);
  try {
    const cleanup = patchYamlConfig(deps, getGlobalConfigPath(), (root) => {
      if (root.llm === undefined) return;
      if (llmConfigurationSourceDigest(root.llm as SharedLLMInput) !== sourceDigest) {
        throw new LLMConfigurationMigrationError(
          `LLM migration source changed before cleanup; root preserved: ${migrationId}`,
          migrationId,
        );
      }
      delete root.llm;
    });
    recordLLMMigrationSourceCleanup(deps, migrationId, cleanup);
  } catch (error) {
    try {
      recordLLMMigrationSourceCleanupFailure(deps, migrationId, error);
    } catch {
      // silent: 原始清源错误优先；目标与源均保留，下次恢复仍会重试。
    }
    throw error;
  }
}

/** 管理命令的迁移入口：root 锁内复核 sourceDigest，目标确认后才清源。 */
export async function migrateRootLLMConfigLocked(deps: {
  fsFactory: (baseDir: string) => FileSystem;
}): Promise<void> {
  // Root relocation and in-place shared-document migration are separate locks.
  // Shared must become explicit first: createFromSource validates the existing
  // target with the strict schema and cannot consume a legacy shared document.
  await createLLMConfigurationDocumentStore(deps).migrateLegacyDocument();
  await withYamlConfigLock(deps, getGlobalConfigPath(), () => {
    const legacy = readRawRootLLM(deps);
    if (legacy !== undefined) migrateRootLLM(deps, legacy);
  });
}

export function loadGlobalConfig(deps: { fsFactory: (baseDir: string) => FileSystem }): ClawGlobalConfig {
  const configPath = getGlobalConfigPath();
  try {
    const stored = loadYamlConfig<Omit<ClawGlobalConfig, 'llm'> & { llm?: unknown }>(
      { fsFactory: deps.fsFactory, resolveEnvVar: makeEnvVarResolver(deps) },
      configPath,
      createStoredGlobalConfigSchema(),
    );
    if (configExists(deps, getLLMConfigurationPath())) {
      const legacy = readRawRootLLM(deps);
      if (legacy !== undefined) migrateRootLLM(deps, legacy);
      return withLLMView(stored, createLLMConfiguration(deps).loadGlobal());
    }
    const legacy = readRawRootLLM(deps);
    if (legacy === undefined) {
      // 另一并发读取可能已在两次磁盘观察之间完成迁移并清源。
      if (configExists(deps, getLLMConfigurationPath())) {
        return withLLMView(stored, createLLMConfiguration(deps).loadGlobal());
      }
      throw new Error('Invalid global config: missing llm section');
    }
    migrateRootLLM(deps, legacy);
    return withLLMView(stored, createLLMConfiguration(deps).loadGlobal());
  } catch (err) {
    if (isConfigStoreError(err)) {
      throw mapConfigStoreError(err, 'global');
    }
    throw err;
  }
}

export function isInitialized(deps: { fsFactory: (baseDir: string) => FileSystem }): boolean {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}

/* ---------- Phase 1911 Step D: init 完整 bootstrap 发布 ---------- */

/**
 * Phase 1911 Step D（RACE-CONFIG-INIT-PARTIAL-PUBLISH）：ready marker。
 * root config YAML 的 O_EXCL 提交只是 bootstrap 的 durable intent；
 * 「workspace initialized」对消费者可见的唯一依据是本 marker，且只在
 * audit/watchdog config 与 logs 等必需布局核验完整后发布。LLM probe
 * 不属于 ready（transient 网络失败不得阻断布局完整性判定）。
 */
export const INITIALIZATION_MARKER = '.initialized' as const;

export type InitializationState =
  | 'absent'       // 无 root config —— 从未初始化
  | 'in_progress'  // root config 在、marker 缺 —— 崩溃窗口或 legacy 无 marker 布局
  | 'ready'        // root config + marker + 必需布局核验完整
  | 'invalid';     // root config 损坏 / marker 声称 ready 但布局损坏 —— fail-closed

export type InitializationInspection =
  | { readonly state: 'absent' | 'in_progress' | 'ready' }
  | {
    readonly state: 'invalid';
    readonly reason: 'root_config' | 'llm_document' | 'audit_config' | 'watchdog_config' | 'layout';
    readonly cause: unknown;
  };

type BootstrapCheck = 'complete' | 'incomplete' | 'broken';

/** 必需布局核验：audit/watchdog config（owner typed load）+ logs 目录。 */
function checkWorkspaceBootstrap(deps: { fsFactory: (baseDir: string) => FileSystem }): BootstrapCheck {
  const chestnutRootFs = deps.fsFactory(getChestnutRoot());
  const audit = loadWorkspaceAuditConfig(chestnutRootFs);
  const watchdog = loadWorkspaceWatchdogConfig(chestnutRootFs);
  if (audit.kind === 'invalid' || watchdog.kind === 'invalid') return 'broken';
  if (audit.kind !== 'ok' || watchdog.kind !== 'ok') return 'incomplete';
  return chestnutRootFs.existsSync('logs') ? 'complete' : 'incomplete';
}

/** Structural initialization inspection; LLM credentials are deliberately not resolved. */
export function inspectInitialization(deps: { fsFactory: (baseDir: string) => FileSystem }): InitializationInspection {
  if (!isInitialized(deps)) return { state: 'absent' };
  let hasLLMConfiguration = false;
  try {
    const raw = readYamlDocument(deps, getGlobalConfigPath());
    const root = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const legacy = root.llm as SharedLLMInput | undefined;
    hasLLMConfiguration = configExists(deps, getLLMConfigurationPath()) || legacy !== undefined;
    if (legacy === undefined) {
      // No legacy LLM section remains, so expansion can only affect root-owned fields.
      loadYamlConfig(
        { fsFactory: deps.fsFactory, resolveEnvVar: makeEnvVarResolver(deps) },
        getGlobalConfigPath(),
        createStoredGlobalConfigSchema(),
      );
    } else {
      // Validate legacy structure without expanding its credential references.
      createStoredGlobalConfigSchema().parse(raw);
    }
  } catch (error) {
    if (isConfigStoreError(error) && !['invalid_yaml', 'invalid_schema', 'missing_env'].includes(error.code)) {
      throw error;
    }
    return { state: 'invalid', reason: 'root_config', cause: error };
  }
  if (configExists(deps, getLLMConfigurationPath())) {
    try {
      createLLMConfigurationDocumentStore(deps).read();
    } catch (error) {
      if (isConfigStoreError(error) && !['invalid_yaml', 'invalid_schema'].includes(error.code)) throw error;
      return { state: 'invalid', reason: 'llm_document', cause: error };
    }
  }

  const chestnutRootFs = deps.fsFactory(getChestnutRoot());
  const markerPresent = chestnutRootFs.existsSync(INITIALIZATION_MARKER);
  const audit = loadWorkspaceAuditConfig(chestnutRootFs);
  if (audit.kind === 'invalid') {
    return { state: 'invalid', reason: 'audit_config', cause: audit };
  }
  const watchdog = loadWorkspaceWatchdogConfig(chestnutRootFs);
  if (watchdog.kind === 'invalid') {
    return { state: 'invalid', reason: 'watchdog_config', cause: watchdog };
  }
  const complete = audit.kind === 'ok' && watchdog.kind === 'ok' && chestnutRootFs.existsSync('logs');
  if (markerPresent) {
    if (!hasLLMConfiguration) return { state: 'in_progress' };
    return complete
      ? { state: 'ready' }
      : { state: 'invalid', reason: 'layout', cause: new Error('Ready marker has incomplete workspace layout') };
  }
  return { state: 'in_progress' };
}

/** Compatibility projection for callers that only need the historical four-state layout. */
export function getInitializationState(deps: { fsFactory: (baseDir: string) => FileSystem }): InitializationState {
  return inspectInitialization(deps).state;
}

/**
 * 幂等完成 bootstrap：各 owner 幂等物化（合法已存在 → 'already' 不覆盖，
 * invalid → owner throw fail-loud），核验后最后发布 ready marker。
 * 覆盖三条路径：fresh init winner、并发 loser 协助收敛、崩溃/legacy 恢复。
 */
export function completeInitialization(deps: { fsFactory: (baseDir: string) => FileSystem }): void {
  // Structural completion never requires every LLM credential to be available.
  const inspection = inspectInitialization(deps);
  if (inspection.state === 'invalid') {
    throw new Error(`Workspace initialization structure is invalid (${inspection.reason})`, { cause: inspection.cause });
  }
  if (inspection.state === 'absent') throw new Error('Workspace initialization is absent');
  if (configExists(deps, getLLMConfigurationPath())) {
    createLLMConfigurationDocumentStore(deps).read();
  } else {
    const legacy = readRawRootLLM(deps);
    if (legacy === undefined) throw new Error('Workspace LLM configuration is not initialized');
    migrateRootLLM(deps, legacy);
    createLLMConfigurationDocumentStore(deps).read();
  }
  const chestnutRootFs = deps.fsFactory(getChestnutRoot());
  initWorkspaceAuditConfig(chestnutRootFs);
  publishAuditLayout(chestnutRootFs);
  initWorkspaceWatchdogConfig(chestnutRootFs);
  publishWatchdogLayout(chestnutRootFs);
  chestnutRootFs.ensureDirSync('logs');
  if (checkWorkspaceBootstrap(deps) !== 'complete') {
    throw new Error(
      'Workspace bootstrap verification failed after materialization; ' +
      'ready marker NOT published (evidence preserved)',
    );
  }
  const marker = {
    schema_version: 1,
    owner: 'assembly-root-config',
  } as const;
  chestnutRootFs.writeAtomicSync(INITIALIZATION_MARKER, `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * Phase 1910 Step D（RACE-CONFIG-INIT-LOST-UPDATE）：workspace 初始化的唯一
 * 提交点。目标已存在（并发 init winner）→ GlobalConfigAlreadyExistsError，
 * loser 重读已提交配置、不覆盖。
 */
export class GlobalConfigAlreadyExistsError extends Error {
  constructor(readonly configPath: string) {
    super(`Global config already initialized: ${configPath}`);
    this.name = 'GlobalConfigAlreadyExistsError';
  }
}

export function saveGlobalConfigExclusive(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  config: Omit<ClawGlobalConfigInput, 'llm'> & { llm?: ClawGlobalConfigInput['llm'] },
): void {
  const configPath = getGlobalConfigPath();
  try {
    writeYamlConfigExclusive(
      { fsFactory: deps.fsFactory },
      configPath,
      config,
    );
  } catch (err) {
    if (isConfigStoreError(err) && err.code === 'already_exists') {
      throw new GlobalConfigAlreadyExistsError(configPath);
    }
    throw err;
  }
}

/**
 * Phase 1910 Step D（RACE-CONFIG-READ-MODIFY-WRITE）：global config 的
 * 串行化 read→modify→write。锁内重新读盘（不用调用方旧快照），mutator 抛出
 * 的业务错误原样传播且不提交。与 loadGlobal+saveGlobal 逐语义等价，仅增加
 * 跨进程序列化。
 */
export async function mutateGlobalConfigLocked(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  mutator: (config: ClawGlobalConfig) => void,
): Promise<AtomicWriteResult> {
  // 兼容旧 Assembly 调用方面；实际 LLM RMW 已归 L4，root 不再承载业务写。
  loadGlobalConfig(deps);
  return createLLMConfiguration(deps).mutateGlobalLocked((fresh) => {
    mutator({ llm: fresh.llm } as ClawGlobalConfig);
  });
}

export function loadClawConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string): ClawConfig | undefined {
  if (!configExists({ fsFactory: deps.fsFactory }, configPath)) {
    return undefined;
  }
  try {
    let rawLLM: LLMClawConfigView['raw'];
    const credentialSources: Record<string, CredentialSource> = {};
    const credentialFacts: Record<string, CredentialFact> = {};
    const credentialHits = new Map<string, ResolvedAuthenticationSetupCredential | undefined>();
    const authentication = createAuthenticationSetup({ fsFactory: deps.fsFactory });
    const resolved = loadYamlConfig<ClawConfig>(
      {
        fsFactory: deps.fsFactory,
        resolveEnvVar: (name) => {
          if (!credentialHits.has(name)) credentialHits.set(name, authentication.resolveSync(name));
          const hit = credentialHits.get(name);
          if (hit !== undefined && credentialFacts[name] === undefined) {
            credentialSources[name] = hit.source;
            credentialFacts[name] = {
              source: hit.source,
              revision: sha256Hex(`${hit.source}\0${hit.accessToken}`),
              identityRef: name,
            };
          }
          return hit?.accessToken;
        },
        validateRaw: (value) => {
          assertNoLegacyPlaintextApiKey(value);
          const llm = (value as { llm?: { primary?: SharedLLMInput['primary'] } }).llm;
          rawLLM = llm?.primary !== undefined ? { primary: llm.primary } : undefined;
        },
      },
      configPath,
      getClawConfigSchema(),
    );
    if (rawLLM !== undefined) Object.defineProperty(resolved, 'raw', { value: rawLLM, enumerable: false });
    Object.defineProperty(resolved, 'credentialSources', { value: credentialSources, enumerable: false });
    Object.defineProperty(resolved, 'credentialFacts', { value: credentialFacts, enumerable: false });
    return resolved;
  } catch (err) {
    if (isConfigStoreError(err)) {
      throw mapConfigStoreError(err, 'claw');
    }
    throw err;
  }
}

export async function migrateClawLegacyApiKeys(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  configPath: string,
): Promise<void> {
  if (!configExists(deps, configPath)) return;
  await migrateLegacyApiKeysAtPath(deps, configPath);
}

export async function patchGlobalConfigPrimary(deps: { fsFactory: (baseDir: string) => FileSystem }, patch: Record<string, unknown>): Promise<AtomicWriteResult> {
  const raw = readYamlDocument(deps, getGlobalConfigPath());
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`config parse failed: expected object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
  }
  loadGlobalConfig(deps);
  return createLLMConfiguration(deps).patchPrimary(patch);
}

function withClawPrimaryEntryId(config: ClawConfig): ClawConfig {
  // Assembly owns claw files and assigns identity only on these explicit writes;
  // loadClawConfig never backfills. An existing override keeps its own ID.
  const primary = config.llm?.primary;
  if (primary === undefined || primary.entry_id !== undefined) return config;
  return {
    ...config,
    llm: { ...config.llm, primary: { ...primary, entry_id: newUuid() } },
  };
}

export function saveClawConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string, config: ClawConfig): AtomicWriteResult {
  return writeYamlConfig(
    { fsFactory: deps.fsFactory },
    configPath,
    withClawPrimaryEntryId(config),
  );
}

/** Durable Assembly owner for legacy claw overrides; L2 never writes configuration IDs. */
export async function ensureClawPrimaryEntryId(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  configPath: string,
): Promise<void> {
  if (!configExists(deps, configPath)) return;
  await withYamlConfigLock(deps, configPath, () => {
    const fresh = readYamlDocument(deps, configPath);
    getClawConfigSchema().parse(fresh);
    const primary = (fresh as ClawConfig).llm?.primary;
    if (primary === undefined || primary.entry_id !== undefined) return;
    // Reuse the existing Assembly save path under the lock; all unrelated raw fields survive.
    const result = saveClawConfig(deps, configPath, fresh as ClawConfig);
    if (result.kind !== 'durable') {
      throw new Error('Claw LLM provider entry identity backfill was not confirmed durable', { cause: result.error });
    }
  });
}

/**
 * Phase 1910 Step E（RACE-CLAW-CREATE-CHECK-THEN-CREATE）：claw 创建的独占
 * 发布提交点。claw config 是 claw 资源的身份 artifact（loadClaw 读它），
 * O_EXCL 独占创建即创建权裁决；已存在 → ClawConfigAlreadyExistsError，
 * loser 不得覆盖。
 */
export class ClawConfigAlreadyExistsError extends Error {
  constructor(readonly configPath: string) {
    super(`Claw config already exists: ${configPath}`);
    this.name = 'ClawConfigAlreadyExistsError';
  }
}

export function saveClawConfigExclusive(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string, config: ClawConfig): void {
  try {
    writeYamlConfigExclusive(
      { fsFactory: deps.fsFactory },
      configPath,
      withClawPrimaryEntryId(config),
    );
  } catch (err) {
    if (isConfigStoreError(err) && err.code === 'already_exists') {
      throw new ClawConfigAlreadyExistsError(configPath);
    }
    throw err;
  }
}

export function clawExists(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string): boolean {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}
