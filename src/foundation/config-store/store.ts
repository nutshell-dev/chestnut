/**
 * @module L2a.ConfigStore
 * @layer L2 基础层
 *
 * Generic YAML config persistence：schema 参数化的 load/write/patch/exists。
 * 零业务字段含义 — owner schema、文件路径与业务错误措辞全部由 caller 决定。
 *
 * 保留：env var expansion（`${ENV_VAR}` → process.env.X）、atomic+fsync 写
 * （写委托 L1 FileSystem.writeAtomicSync）。
 * 预期失败经 typed failure protocol（./errors.ts）抛出，见 ConfigStoreError。
 *
 * Phase 10 Step B: thin YAML config loader（Refs: coding plan/phase10/Step B.md §3.2）
 * Phase 717: 迁入 L6
 * Phase 1297 Step A: 归位 L2a ConfigStore（自 L6 config 目录物理迁入）
 * Phase 1297 Step B: typed failure protocol；error 格式化改为模块私有
 *   formatUnknownError，最终依赖只剩 FileSystem 与通用库（path/js-yaml）。
 */
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { FileSystem } from '../fs/index.js';
import { ConfigStoreError } from './errors.js';

/**
 * 模块私有 unknown error 格式化（phase 1297 Step B：替代 NodeUtils formatErr，
 * 消除 ConfigStore → NodeUtils 依赖边）。仅单行 head，不展开 cause 链。
 */
function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const head = error.message || error.name || 'Error';
    return code ? `[${code}] ${head}` : head;
  }
  return String(error);
}

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

interface LoaderDeps {
  fsFactory: (baseDir: string) => FileSystem;
}

/**
 * Schema 结构契约（phase 1297 Step B）：ConfigStore 不 import Zod 类型，
 * 只要求 caller 传入带 parse 的对象。
 */
export interface ConfigSchema<T> {
  parse(data: unknown): T;
}

/**
 * Load YAML config file + parse via caller-supplied schema.
 * Returns typed result; expected failures throw ConfigStoreError
 * （not_found / read_failed / invalid_yaml / missing_env / invalid_schema），
 * 业务措辞由 caller 按 code 决定。
 */
export function loadYamlConfig<T>(
  deps: LoaderDeps,
  configPath: string,
  schema: ConfigSchema<T>,
): T {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const basename = path.basename(configPath);

  if (!fs.existsSync(basename)) {
    throw new ConfigStoreError('not_found', `Config not found: ${configPath}`);
  }

  let content: string;
  try {
    content = fs.readSync(basename);
  } catch (err) {
    throw new ConfigStoreError('read_failed', `Failed to read config: ${formatUnknownError(err)}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new ConfigStoreError('invalid_yaml', `Invalid YAML in config: ${formatUnknownError(err)}`, { cause: err });
  }

  let expanded: unknown;
  try {
    expanded = expandEnvVars(parsed);
  } catch (err) {
    throw new ConfigStoreError('missing_env', `Invalid config (env var): ${formatUnknownError(err)}`, { cause: err });
  }

  try {
    return schema.parse(expanded);
  } catch (err) {
    throw new ConfigStoreError('invalid_schema', `Invalid config: ${formatUnknownError(err)}`, { cause: err });
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
 * 供 caller 就地修补局部字段而不触发 schema default 重新注入
 * （保留用户省略的 optional 字段）。
 *
 * read/YAML/top-level-shape 失败进入同一 typed taxonomy（read_failed /
 * invalid_yaml / expected_object）；patcher 自己抛出的错误原样传播、不包装。
 */
export function patchYamlConfig(
  deps: LoaderDeps,
  configPath: string,
  patcher: (cfg: Record<string, unknown>) => void,
): void {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const basename = path.basename(configPath);

  let content: string;
  try {
    content = fs.readSync(basename);
  } catch (err) {
    throw new ConfigStoreError('read_failed', `Failed to read config: ${formatUnknownError(err)}`, { cause: err });
  }

  let loaded: unknown;
  try {
    loaded = yaml.load(content);
  } catch (err) {
    throw new ConfigStoreError('invalid_yaml', `Invalid YAML in config: ${formatUnknownError(err)}`, { cause: err });
  }

  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new ConfigStoreError('expected_object', `config parse failed: expected object, got ${typeof loaded}`);
  }
  const cfg = loaded as Record<string, unknown>;
  patcher(cfg);
  const dumped = yaml.dump(cfg);
  fs.writeAtomicSync(basename, dumped);
}

/**
 * Check if a config file exists at the given path.
 */
export function configExists(deps: LoaderDeps, configPath: string): boolean {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  return fs.existsSync(path.basename(configPath));
}
