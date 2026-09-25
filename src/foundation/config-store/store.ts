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

/* ---------- Phase 1910 Step D: 并发提交协议 ---------- */

/**
 * Phase 1910 Step D（RACE-CONFIG-INIT-LOST-UPDATE）：O_EXCL 独占创建提交。
 *
 * 首次初始化等「只能提交一次」的场景使用：目标已存在 → typed 'already_exists'，
 * 绝不覆盖。存在性快照（configExists/isInitialized）只是诊断，创建权由本调用裁决。
 */
export function writeYamlConfigExclusive(
  deps: LoaderDeps,
  configPath: string,
  config: unknown,
): void {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const basename = path.basename(configPath);
  const content = yaml.dump(config);
  try {
    fs.writeExclusiveSync(basename, content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new ConfigStoreError('already_exists', `Config already exists: ${configPath}`, { cause: err });
    }
    throw err;
  }
}

/** lock 内容可解析但超过该年龄 → 视为 holder 崩溃残留，可回收。 */
const CONFIG_LOCK_STALE_MS = 30_000;
/** 获取锁的总预算；超时 typed 'lock_timeout' 交给 caller（不静默等待永远）。 */
const CONFIG_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const CONFIG_LOCK_POLL_MS = 50;

interface ConfigLockPayload {
  pid: number;
  createdAt: string;
}

function readLockFresh(fs: FileSystem, lockName: string, staleMs: number): boolean {
  // 返回 true = 锁仍被有效持有；false = 可回收（不存在 / 过期）
  let raw: string;
  try {
    raw = fs.readSync(lockName);
  } catch {
    return false; // 读不到（ENOENT/竞争删除）→ 可回收
  }
  let payload: ConfigLockPayload;
  try {
    payload = JSON.parse(raw) as ConfigLockPayload;
  } catch {
    // O_EXCL 先发布路径再完成内容：半写 lock 视为「持有中」，下一轮重读
    return true;
  }
  const createdAt = Date.parse(payload?.createdAt ?? '');
  if (Number.isNaN(createdAt)) return true; // 内容不可判龄 → 保守持有
  return Date.now() - createdAt < staleMs;
}

async function acquireConfigLock(
  fs: FileSystem,
  lockName: string,
  opts: { acquireTimeoutMs: number; staleMs: number; pollMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.acquireTimeoutMs;
  for (;;) {
    const payload: ConfigLockPayload = { pid: process.pid, createdAt: new Date().toISOString() };
    try {
      fs.writeExclusiveSync(lockName, JSON.stringify(payload));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }
    if (Date.now() >= deadline) {
      throw new ConfigStoreError(
        'lock_timeout',
        `Config lock acquire timeout: ${lockName} held by another process`,
      );
    }
    if (!readLockFresh(fs, lockName, opts.staleMs)) {
      // holder 崩溃残留 —— 删除后经下一轮 O_EXCL 重新裁决（ delete+create 之间
      // 的竞赛由 O_EXCL 仲裁，loser 会看到新鲜 lock 并继续等待）。
      try {
        fs.deleteSync(lockName);
      } catch {
        // silent: 并发回收 / 已被释放 —— 下一轮循环重新判定
      }
      continue;
    }
    await new Promise<void>(resolve => setTimeout(resolve, opts.pollMs));
  }
}

/**
 * Phase 1910 Step D（RACE-CONFIG-READ-MODIFY-WRITE）：per-path 跨进程锁。
 *
 * 在锁内组合本模块既有同步原语（loadYamlConfig / writeYamlConfig /
 * patchYamlConfig），使 read→modify→write 整体串行化：任何成功提交的字段
 * 不会被另一成功 mutation 静默抹掉。锁文件为 `<config>.lock`，O_EXCL 创建裁决；
 * holder 崩溃残留超过 CONFIG_LOCK_STALE_MS 可回收；获取超时 typed
 * 'lock_timeout'。锁不可重入、不可嵌套（CLI 一次性进程语义）。
 */
export async function withYamlConfigLock(
  deps: LoaderDeps,
  configPath: string,
  fn: () => void,
  opts?: { acquireTimeoutMs?: number; staleMs?: number; pollMs?: number },
): Promise<void> {
  const dir = path.dirname(configPath);
  const fs = deps.fsFactory(dir);
  const lockName = `${path.basename(configPath)}.lock`;
  await acquireConfigLock(fs, lockName, {
    acquireTimeoutMs: opts?.acquireTimeoutMs ?? CONFIG_LOCK_ACQUIRE_TIMEOUT_MS,
    staleMs: opts?.staleMs ?? CONFIG_LOCK_STALE_MS,
    pollMs: opts?.pollMs ?? CONFIG_LOCK_POLL_MS,
  });
  try {
    fn();
  } finally {
    try {
      fs.deleteSync(lockName);
    } catch {
      // silent: 锁残留按过期协议回收；不掩盖 fn 的结果
    }
  }
}
