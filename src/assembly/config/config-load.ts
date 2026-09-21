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
  isConfigStoreError,
  type ConfigStoreError,
} from '../../foundation/config-store/index.js';
import { getGlobalConfigPath } from './global-config-path.js';
import { toProviderConfig } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

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
    default: {
      const exhaustive: never = err.code;
      throw new Error(`Unhandled ConfigStoreError code: ${String(exhaustive)}`);
    }
  }
}

export function loadGlobalConfig(deps: { fsFactory: (baseDir: string) => FileSystem }): ClawGlobalConfig {
  const configPath = getGlobalConfigPath();
  const schema = createGlobalConfigSchema();
  try {
    return loadYamlConfig<ClawGlobalConfig>(
      { fsFactory: deps.fsFactory },
      configPath,
      schema,
    );
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
    if (isConfigStoreError(err)) {
      throw mapConfigStoreError(err, 'claw');
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



// Build LLMOrchestratorConfig from global + claw config
// phase 1300 Step A: resolveLLMConfig 为 owner 名称（phase 1886 Step B: 兼容
// alias buildLLMConfig 已删除，src/tests 旧名零命中）。
export function resolveLLMConfig(
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
