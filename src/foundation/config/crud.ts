/**
 * CRUD operations for global + claw configs / phase 500 sub-file extraction
 *
 * CRUD operations for global + claw configs / phase 500 sub-file extraction
 */

import * as fs from 'fs';
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
  getClawDir,
} from '../paths.js';

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
export function loadGlobalConfig(defaults: ConfigDefaults): ClawGlobalConfig {
  const configPath = getGlobalConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error(
      'Global config not found. Run "clawforum init" first.'
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
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
export function isInitialized(): boolean {
  return fs.existsSync(getGlobalConfigPath());
}

// Save global config
export function saveGlobalConfig(config: ClawGlobalConfig): void {
  const configPath = getGlobalConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const content = yaml.dump(config);
  const tmpPath = `${configPath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  const fd = fs.openSync(tmpPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, configPath);
}

// Load claw config
export function loadClawConfig(name: string, defaults: ConfigDefaults): ClawConfig {
  const configPath = getClawConfigPath(name);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Claw "${name}" not found.`);
  }

  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
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
export function patchGlobalConfigPrimary(patch: Record<string, unknown>): void {
  const configPath = getGlobalConfigPath();
  const loaded = yaml.load(fs.readFileSync(configPath, 'utf-8'));
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error(`config parse failed: expected object, got ${typeof loaded}`);
  }
  const cfg = loaded as Record<string, unknown>;
  const llm = (cfg.llm ?? {}) as Record<string, unknown>;
  const primary = (llm.primary ?? {}) as Record<string, unknown>;
  llm.primary = { ...primary, ...patch };
  cfg.llm = llm;
  const content = yaml.dump(cfg);
  const tmpPath = `${configPath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  const fd = fs.openSync(tmpPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, configPath);
}

// Save claw config
export function saveClawConfig(name: string, config: ClawConfig): void {
  const clawDir = getClawDir(name);
  fs.mkdirSync(clawDir, { recursive: true });

  const configPath = getClawConfigPath(name);
  const content = yaml.dump(config);
  const tmpPath = `${configPath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  const fd = fs.openSync(tmpPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, configPath);
}

// Check if claw exists
export function clawExists(name: string): boolean {
  return fs.existsSync(getClawConfigPath(name));
}
