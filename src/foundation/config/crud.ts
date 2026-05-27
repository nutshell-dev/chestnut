/**
 * CRUD operations for global + claw configs / phase 500 sub-file extraction
 *
 * CRUD operations for global + claw configs / phase 500 sub-file extraction
 */

import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  createClawGlobalConfigSchema,
  createClawConfigSchema,
  type ClawGlobalConfig,
  type ClawConfig,
  type ConfigDefaults,
} from './schemas.js';
import {
  getGlobalConfigPath,
  getClawConfigPath,
} from '../paths.js';
import type { FileSystem } from '../fs/types.js';

// Expand ${ENV_VAR} syntax in config values
function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const val = process.env[varName];
      if (val === undefined) {
        throw new Error(`Environment variable "${varName}" is not set`);
      }
      return val;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVars(value);
    }
    return result;
  }
  return obj;
}

// Load global config
export function loadGlobalConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, defaults: ConfigDefaults): ClawGlobalConfig {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);

  if (!fs.existsSync(path.basename(configPath))) {
    throw new Error(
      'Global config not found. Run "clawforum init" first.'
    );
  }

  let content: string;
  try {
    content = fs.readSync(path.basename(configPath));
  } catch (err) {
    throw new Error(`Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new Error(`Invalid YAML in config: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Expand environment variables before validation
  let expanded: unknown;
  try {
    expanded = expandEnvVars(parsed);
  } catch (err) {
    throw new Error(`Invalid global config (env var): ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    return createClawGlobalConfigSchema(defaults).parse(expanded);
  } catch (error) {
    throw new Error(
      `Invalid global config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Check if initialized
export function isInitialized(deps: { fsFactory: (baseDir: string) => FileSystem }): boolean {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}

// Save global config
export function saveGlobalConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, config: ClawGlobalConfig): void {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  const fileSystem = deps.fsFactory(dir);
  const content = yaml.dump(config);
  fileSystem.writeAtomicSync(path.basename(configPath), content);
}

// Load claw config
export function loadClawConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, defaults: ConfigDefaults): ClawConfig {
  const configPath = getClawConfigPath(name);
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);

  if (!fs.existsSync(path.basename(configPath))) {
    throw new Error(`Claw "${name}" not found.`);
  }

  let content: string;
  try {
    content = fs.readSync(path.basename(configPath));
  } catch (err) {
    throw new Error(`Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new Error(`Invalid YAML in config: ${err instanceof Error ? err.message : String(err)}`);
  }

  let expanded: unknown;
  try {
    expanded = expandEnvVars(parsed);
  } catch (err) {
    throw new Error(`Invalid claw config (env var): ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    return createClawConfigSchema(defaults).parse(expanded);
  } catch (error) {
    throw new Error(
      `Invalid claw config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Patch the primary LLM config in-place (raw YAML read/write, no Zod round-trip)
export function patchGlobalConfigPrimary(deps: { fsFactory: (baseDir: string) => FileSystem }, patch: Record<string, unknown>): void {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const loaded = yaml.load(fs.readSync(path.basename(configPath)));
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error(`config parse failed: expected object, got ${typeof loaded}`);
  }
  const cfg = loaded as Record<string, unknown>;
  const llm = (cfg.llm ?? {}) as Record<string, unknown>;
  const primary = (llm.primary ?? {}) as Record<string, unknown>;
  llm.primary = { ...primary, ...patch };
  cfg.llm = llm;
  const content = yaml.dump(cfg);
  fs.writeAtomicSync(path.basename(configPath), content);
}

// Save claw config
export function saveClawConfig(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, config: ClawConfig): void {
  const configPath = getClawConfigPath(name);
  const dir = path.dirname(configPath);
  const fileSystem = deps.fsFactory(dir);
  const content = yaml.dump(config);
  fileSystem.writeAtomicSync(path.basename(configPath), content);
}

// Check if claw exists
export function clawExists(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string): boolean {
  const configPath = getClawConfigPath(name);
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}
