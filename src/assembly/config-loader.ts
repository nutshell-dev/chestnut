/**
 * @module L6.Assembly
 *
 * Phase 10 Step B: thin YAML config loader
 *
 * Generic YAML read/write + Zod parse、不持任何业务字段含义。
 * Replace 既往 crud.ts 内的 schema-specific 加载、改为 caller 传 schema。
 *
 * 保留：env var expansion（`${ENV_VAR}` → process.env.X）、错误归类抛、atomic+fsync 写
 * Refs: coding plan/phase10/Step B.md §3.2
 *
 * Phase 717: 自 foundation/config/loader.ts 迁入 assembly/，归属 L6.Assembly。
 */
import * as path from 'path';
import { formatErr } from "../foundation/node-utils/index.js";
import * as yaml from 'js-yaml';
import type { FileSystem } from '../foundation/fs/index.js';

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

export interface LoaderDeps {
  fsFactory: (baseDir: string) => FileSystem;
}

/**
 * Load YAML config file + parse via Zod schema.
 * Returns typed result or throws Error with descriptive message.
 */
export function loadYamlConfig<T>(
  deps: LoaderDeps,
  configPath: string,
  schema: { parse(data: unknown): T },
  options: { notFoundMessage?: string } = {},
): T {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const basename = path.basename(configPath);

  if (!fs.existsSync(basename)) {
    throw new Error(
      options.notFoundMessage ?? `Config not found: ${configPath}`,
    );
  }

  let content: string;
  try {
    content = fs.readSync(basename);
  } catch (err) {
    throw new Error(`Failed to read config: ${formatErr(err)}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new Error(`Invalid YAML in config: ${formatErr(err)}`, { cause: err });
  }

  let expanded: unknown;
  try {
    expanded = expandEnvVars(parsed);
  } catch (err) {
    throw new Error(`Invalid config (env var): ${formatErr(err)}`, { cause: err });
  }

  try {
    return schema.parse(expanded);
  } catch (error) {
    throw new Error(`Invalid config: ${formatErr(error)}`, { cause: error });
  }
}

/**
 * Write YAML config file atomically (tmp + rename + fsync via writeAtomicSync).
 * Caller passes typed config object、loader serializes to YAML.
 */
export function writeYamlConfig(
  deps: LoaderDeps,
  configPath: string,
  config: unknown,
): void {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const basename = path.basename(configPath);
  const content = yaml.dump(config);
  fs.writeAtomicSync(basename, content);
}

/**
 * In-place YAML patch (raw read/write, no schema round-trip).
 * Used by `chestnut config primary` to patch llm.primary fields without
 * triggering Zod default re-injection (preserves user-omitted optional fields).
 */
export function patchYamlConfig(
  deps: LoaderDeps,
  configPath: string,
  patcher: (cfg: Record<string, unknown>) => void,
): void {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const basename = path.basename(configPath);
  const loaded = yaml.load(fs.readSync(basename));
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error(`config parse failed: expected object, got ${typeof loaded}`);
  }
  const cfg = loaded as Record<string, unknown>;
  patcher(cfg);
  const content = yaml.dump(cfg);
  fs.writeAtomicSync(basename, content);
}

/**
 * Check if a config file exists at the given path.
 */
export function configExists(deps: LoaderDeps, configPath: string): boolean {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}
