/**
 * Assembly config load module
 * phase 298: V12 (b) real-治、wrapper 反向迁 foundation → assembly
 *
 * Owns: root config wrapper (load/save/exists/patch) + LLM merge
 * Generic yaml CRUD remains in ./config-loader.ts (phase 717)
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
} from './config-loader.js';
import { getGlobalConfigPath } from './global-config-path.js';
import { toProviderConfig } from '../../foundation/llm-orchestrator/config-adapter.js';
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
