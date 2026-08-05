/**
 * Assembly config load module
 * phase 298: V12 (b) real-治、wrapper 反向迁 foundation → assembly
 *
 * Owns: root config wrapper (load/save/exists/patch) + LLM merge
 * Generic yaml CRUD remains in ./config-loader.ts (phase 717)
 * path primitive: getGlobalConfigPath in ./global-config-path.ts (phase 704)
 */
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  createGlobalConfigSchema,
  getClawConfigSchema,
  type ClawGlobalConfig,
  type ClawGlobalConfigInput,
  type ClawConfig,
} from './compose-config.js';
import {
  loadYamlConfig,
  writeYamlConfig,
  patchYamlConfig,
  configExists,
} from './config-loader.js';
import { getGlobalConfigPath } from './global-config-path.js';
import { formatErr, sha256Hex } from '../../foundation/node-utils/index.js';
import { auditConfigSchema, AUDIT_LEGACY_PATHS, type AuditConfig } from '../../foundation/audit/index.js';
import { watchdogConfigSchema, type WatchdogConfig } from '../../watchdog/config-schema.js';
import { WATCHDOG_LEGACY_PATHS } from '../../watchdog/layout.js';
import { toProviderConfig } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

export function loadGlobalConfig(deps: { fsFactory: (baseDir: string) => FileSystem }): ClawGlobalConfig {
  const configPath = getGlobalConfigPath();
  const schema = createGlobalConfigSchema();
  try {
    return loadYamlConfig<ClawGlobalConfig>(
      { fsFactory: deps.fsFactory },
      configPath,
      schema,
      { notFoundMessage: 'Global config not found.' },
    );
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.startsWith('Failed to read config:')) {
        throw new Error(err.message, { cause: err });
      }
      if (err.message.startsWith('Invalid YAML in config:')) {
        throw new Error(err.message, { cause: err });
      }
      if (err.message.startsWith('Invalid config (env var):')) {
        throw new Error(err.message.replace('Invalid config (env var):', 'Invalid global config (env var):'), { cause: err });
      }
      if (err.message.startsWith('Invalid config:')) {
        throw new Error(err.message.replace('Invalid config:', 'Invalid global config:'), { cause: err });
      }
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

export function saveGlobalConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, config: ClawGlobalConfigInput): void {
  const configPath = getGlobalConfigPath();
  writeYamlConfig(
    { fsFactory: deps.fsFactory },
    configPath,
    config,
  );
}

export function loadClawConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string): ClawConfig | undefined {
  if (!configExists({ fsFactory: deps.fsFactory }, configPath)) {
    return undefined;
  }
  try {
    return loadYamlConfig<ClawConfig>(
      { fsFactory: deps.fsFactory },
      configPath,
      getClawConfigSchema(),
    );
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.startsWith('Failed to read config:')) {
        throw new Error(err.message, { cause: err });
      }
      if (err.message.startsWith('Invalid YAML in config:')) {
        throw new Error(err.message, { cause: err });
      }
      if (err.message.startsWith('Invalid config (env var):')) {
        throw new Error(err.message.replace('Invalid config (env var):', 'Invalid claw config (env var):'), { cause: err });
      }
      if (err.message.startsWith('Invalid config:')) {
        throw new Error(err.message.replace('Invalid config:', 'Invalid claw config:'), { cause: err });
      }
    }
    throw err;
  }
}

export function patchGlobalConfigPrimary(deps: { fsFactory: (baseDir: string) => FileSystem }, patch: Record<string, unknown>): void {
  const configPath = getGlobalConfigPath();
  patchYamlConfig(
    { fsFactory: deps.fsFactory },
    configPath,
    (cfg) => {
      const llm = cfg.llm as Record<string, unknown> | undefined;
      if (!llm || typeof llm !== 'object') {
        throw new Error('Invalid global config: missing llm section');
      }
      const primary = llm.primary as Record<string, unknown> | undefined;
      if (!primary || typeof primary !== 'object') {
        throw new Error('Invalid global config: missing llm.primary section');
      }
      for (const [k, v] of Object.entries(patch)) {
        primary[k] = v;
      }
    },
  );
}

export function saveClawConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string, config: ClawConfig): void {
  writeYamlConfig(
    { fsFactory: deps.fsFactory },
    configPath,
    config,
  );
}

export function clawExists(deps: { fsFactory: (baseDir: string) => FileSystem }, configPath: string): boolean {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}

// ── Phase 1288 Step B: legacy root YAML `audit:` 段（Assembly 拥有 root YAML IO）──
//
// 迁移协议中 Assembly 侧的两次 mutation 原语：raw 读取 legacy 段（typed 返回
// AuditConfig + 原文 canonical dump 的 source hash，不暴露完整 GlobalConfig）
// 与原子移除 legacy 段（raw YAML patch + 回读校验，不走 schema round-trip、
// 未知/非 audit 字段逐字节语义保持）。编排归 CLIProcess（cli/audit-config-migration.ts）。

export interface LegacyAuditConfigSection {
  config: AuditConfig;
  /** legacy 段原文（js-yaml canonical dump）的 sha256 hex。 */
  sourceHash: string;
}

/** raw 读取 root YAML 的 legacy `audit:` 段；文件或段不存在 → undefined。 */
export function readLegacyAuditConfigSection(deps: { fsFactory: (baseDir: string) => FileSystem }): LegacyAuditConfigSection | undefined {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const basename = path.basename(configPath);
  if (!fs.existsSync(basename)) return undefined;

  let loaded: unknown;
  try {
    loaded = yaml.load(fs.readSync(basename));
  } catch (err) {
    throw new Error(`Invalid YAML in config: ${formatErr(err)}`, { cause: err });
  }
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error(`Invalid global config: expected object at root, got ${Array.isArray(loaded) ? 'array' : typeof loaded}`);
  }
  const section = (loaded as Record<string, unknown>)[AUDIT_LEGACY_PATHS.configSection];
  if (section === undefined) return undefined;

  let config: AuditConfig;
  try {
    config = auditConfigSchema.parse(section);
  } catch (err) {
    throw new Error(`Invalid global config: legacy audit section: ${formatErr(err)}`, { cause: err });
  }
  return { config, sourceHash: sha256Hex(yaml.dump(section)) };
}

/**
 * 原子移除 root YAML 的 legacy `audit:` 段 + 回读校验。
 * raw YAML patch（同 patchYamlConfig 模式）：不 schema round-trip 重写整个文件，
 * 未知/非 audit 字段保持原值且不注入任何 schema default。段本不存在 → no-op（幂等）。
 */
export function removeLegacyAuditConfigSection(deps: { fsFactory: (baseDir: string) => FileSystem }): void {
  const configPath = getGlobalConfigPath();
  patchYamlConfig(
    { fsFactory: deps.fsFactory },
    configPath,
    (cfg) => {
      delete cfg[AUDIT_LEGACY_PATHS.configSection];
    },
  );
  // 回读校验：段必须真的消失（防写损坏 / 部分写成功伪装完成）。
  if (readLegacyAuditConfigSection(deps) !== undefined) {
    throw new Error(`Failed to remove legacy audit section from ${configPath}: readback still present`);
  }
}

// ── Phase 1289 Step B: legacy root YAML `watchdog:` 段（Assembly 拥有 root YAML IO）──
//
// 迁移协议中 Assembly 侧的两次 mutation 原语：raw 读取 legacy 段（typed 返回
// WatchdogConfig + 退役字段捕获 + 原文 canonical dump 的 source hash，不暴露完整
// GlobalConfig）与原子移除 legacy 段（raw YAML patch + 回读校验，不走 schema
// round-trip、未知/非 watchdog 字段逐字节语义保持）。编排归 CLIProcess
//（cli/watchdog-config-migration.ts）。本边为临时迁移原语，Step D 计划删除。

export interface LegacyWatchdogConfigSection {
  config: WatchdogConfig;
  /**
   * 显式退役字段：legacy 段中 log_archive_days（现有 schema 会静默剥离）为
   * number 时捕获于此，由编排层写入 journal intent；不进入新 schema。
   */
  retired: { log_archive_days?: number };
  /** legacy 段原文（js-yaml canonical dump）的 sha256 hex。 */
  sourceHash: string;
}

/** raw 读取 root YAML 的 legacy `watchdog:` 段；文件或段不存在 → undefined。 */
export function readLegacyWatchdogConfigSection(deps: { fsFactory: (baseDir: string) => FileSystem }): LegacyWatchdogConfigSection | undefined {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const basename = path.basename(configPath);
  if (!fs.existsSync(basename)) return undefined;

  let loaded: unknown;
  try {
    loaded = yaml.load(fs.readSync(basename));
  } catch (err) {
    throw new Error(`Invalid YAML in config: ${formatErr(err)}`, { cause: err });
  }
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error(`Invalid global config: expected object at root, got ${Array.isArray(loaded) ? 'array' : typeof loaded}`);
  }
  const section = (loaded as Record<string, unknown>)[WATCHDOG_LEGACY_PATHS.configSection];
  if (section === undefined) return undefined;

  let config: WatchdogConfig;
  try {
    // zod 默认剥离未知键：log_archive_days 等退役字段不进入 typed config。
    config = watchdogConfigSchema.parse(section);
  } catch (err) {
    throw new Error(`Invalid global config: legacy watchdog section: ${formatErr(err)}`, { cause: err });
  }
  const retired: { log_archive_days?: number } = {};
  if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
    const logArchiveDays = (section as Record<string, unknown>).log_archive_days;
    if (typeof logArchiveDays === 'number') {
      retired.log_archive_days = logArchiveDays;
    }
  }
  return { config, retired, sourceHash: sha256Hex(yaml.dump(section)) };
}

/**
 * 原子移除 root YAML 的 legacy `watchdog:` 段 + 回读校验。
 * raw YAML patch（同 patchYamlConfig 模式）：不 schema round-trip 重写整个文件，
 * 未知/非 watchdog 字段保持原值且不注入任何 schema default。段本不存在 → no-op（幂等）。
 */
export function removeLegacyWatchdogConfigSection(deps: { fsFactory: (baseDir: string) => FileSystem }): void {
  const configPath = getGlobalConfigPath();
  patchYamlConfig(
    { fsFactory: deps.fsFactory },
    configPath,
    (cfg) => {
      delete cfg[WATCHDOG_LEGACY_PATHS.configSection];
    },
  );
  // 回读校验：段必须真的消失（防写损坏 / 部分写成功伪装完成）。
  if (readLegacyWatchdogConfigSection(deps) !== undefined) {
    throw new Error(`Failed to remove legacy watchdog section from ${configPath}: readback still present`);
  }
}

// Build LLMOrchestratorConfig from global + claw config
export function buildLLMConfig(
  globalConfig: ClawGlobalConfig,
  clawConfig?: ClawConfig
): LLMOrchestratorConfig {
  // Use claw's primary if provided, otherwise use global's primary
  const primaryProvider = clawConfig?.llm?.primary
    ? toProviderConfig(clawConfig.llm.primary)
    : toProviderConfig(globalConfig.llm.primary);

  const fallbackList = globalConfig.llm.fallbacks ?? [];

  // Circuit breaker config
  const cb = globalConfig.llm.circuit_breaker;

  return {
    primary: primaryProvider,
    fallbacks: fallbackList.map(toProviderConfig),
    maxAttempts: globalConfig.llm.retry_attempts,
    retryDelayMs: globalConfig.llm.retry_delay_ms,
    events: { emit: () => {} },
    circuitBreaker: cb ? {
      failureThreshold: cb.failure_threshold,
      resetTimeoutMs: cb.reset_timeout_ms,
    } : undefined,
  };
}
