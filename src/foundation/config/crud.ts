/**
 * Phase 10 Step C: facade re-implemented on loader + composer.
 * Public function signatures preserved (callers unchanged except for removing `defaults` param).
 */
import * as path from 'path';
import {
  createGlobalConfigSchema,
  getClawConfigSchema,
  type ClawGlobalConfig,
  type ClawGlobalConfigInput,
  type ClawConfig,
} from '../../assembly/compose-config.js';
import {
  loadYamlConfig,
  writeYamlConfig,
  patchYamlConfig,
  configExists,
} from './loader.js';
// phase 81: API reframe — crud.ts 0 知 chestnut path 约定、纯 yaml CRUD generic、M#1 SRP 真守。
// caller (L6) 自调 getClawConfigPath(name) 然后传 configPath、M#5 守。
import { getGlobalConfigPath } from './global-config-path.js';
import type { FileSystem } from '../fs/types.js';

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

// Re-export type for caller convenience
export type { ClawGlobalConfig, ClawConfig };
