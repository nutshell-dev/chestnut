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
import { isAlive, getProcessStartTime, makeProcessStartTime } from '../process-exec/index.js';
import { newShortUuid } from '../node-utils/index.js';
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

/** lock 内容可解析且超过该年龄 → 触发 holder 活性探测（时间只触发探测，不授予删除权）。 */
const CONFIG_LOCK_STALE_MS = 30_000;
/** 获取锁的总预算；超时 typed 'lock_timeout' 交给 caller（不静默等待永远）。 */
const CONFIG_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const CONFIG_LOCK_POLL_MS = 50;

/**
 * Phase 1911 Step C（RACE-CONFIG-LOCK-STALE-RECLAIM）：lock payload。
 * - `token`：本代锁的 owner 身份（release 只删自己持有的 token；回收按代际复核）；
 * - `pid` + `process_start_time`：holder 活性证明（PID 回收防御）；
 * - `createdAt`：仅决定何时开始探测，时间戳本身不构成回收依据。
 * 1910 legacy lock（无 token / 无 startTime）仍可被读：token 缺省 → 以
 * `pid:createdAt` 为代际身份；startTime 缺省 → 活性降级为 kill(0) 判定。
 */
interface ConfigLockPayload {
  token?: string;
  pid?: number;
  process_start_time?: string;
  createdAt?: string;
}

/** 代际身份：token 优先；legacy 退化为 pid+createdAt；不可解析以原文为身份。 */
function lockIdentity(raw: string): string {
  try {
    const payload = JSON.parse(raw) as ConfigLockPayload;
    if (typeof payload.token === 'string' && payload.token !== '') return `token:${payload.token}`;
    return `legacy:${String(payload.pid)}:${String(payload.createdAt)}`;
  } catch {
    // silent: 不可解析内容以原文为代际身份（保守不授予回收权）
    return `raw:${raw}`;
  }
}

type LockObservation =
  | { kind: 'absent' }                     // 读时已被释放 —— 下一轮 O_EXCL 裁决
  | { kind: 'unreadable' }                 // EIO/EACCES 等 —— 不可判，保守持有
  | { kind: 'malformed' }                  // 半写（O_EXCL 先发布路径）—— 保守持有
  | { kind: 'ok'; raw: string; payload: ConfigLockPayload };

function observeLock(fs: FileSystem, lockName: string): LockObservation {
  let raw: string;
  try {
    raw = fs.readSync(lockName);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable' }; // 读错误 ≠ 可回收（1911：不再折叠成可删）
  }
  let payload: ConfigLockPayload;
  try {
    payload = JSON.parse(raw) as ConfigLockPayload;
  } catch {
    // silent: 半写 lock（O_EXCL 先发布路径）—— 保守持有，交超时/活性协议
    return { kind: 'malformed' };
  }
  return { kind: 'ok', raw, payload };
}

/**
 * holder 活性证明：仅当 ESRCH（进程不存在）或 PID 已回收（startTime 不匹配）
 * 才返回 false —— 两者都是确凿死亡证据。EPERM / ps 不可用 / 字段缺失一律
 * 保守存活（不确定 ≠ 死亡，不授予删除权）。
 */
function isLockHolderAlive(payload: ConfigLockPayload): boolean {
  if (typeof payload.pid !== 'number' || !Number.isInteger(payload.pid) || payload.pid <= 0) {
    return true; // 无 pid 可探测 → 保守持有
  }
  const startTime = typeof payload.process_start_time === 'string' && payload.process_start_time !== ''
    ? makeProcessStartTime(payload.process_start_time)
    : undefined;
  return isAlive(payload.pid, startTime);
}

/** 是否到达探测窗口（年龄只触发探测；判龄失败保守不探测）。 */
function isLockProbeDue(payload: ConfigLockPayload, staleMs: number): boolean {
  const createdAt = Date.parse(payload.createdAt ?? '');
  if (Number.isNaN(createdAt)) return false;
  return Date.now() - createdAt >= staleMs;
}

/**
 * 回收已证明死亡的 holder 的 lock。原子抢占靠 rename-claim（POSIX rename 原子、
 * 同一路径 corpse 恰好被一个 reclaimer 搬走；其余 ENOENT race-lost），抢到后
 * 必须复核代际身份仍是刚证明死亡的那一代才删除；若不匹配（抢到更新一代、其
 * holder 可能活跃），以 O_EXCL 写回原路径恢复，恢复受阻则保留 claim 证据并
 * typed 'lock_indeterminate' 交 owner recovery —— 绝不静默删除不确定代际。
 */
async function tryReclaimDeadHolder(
  fs: FileSystem,
  lockName: string,
  provedRaw: string,
): Promise<void> {
  const claimName = `${lockName}.reclaim-${newShortUuid()}`;
  try {
    await fs.move(lockName, claimName);
  } catch {
    return; // ENOENT race-lost / 临时 I/O 错误 —— 保持 lock，下一轮重判或超时
  }
  let claimedRaw: string | null = null;
  try {
    claimedRaw = fs.readSync(claimName);
  } catch {
    // silent: corpse 读不回 —— 下方以 null 走 lock_indeterminate 证据保留路径
    claimedRaw = null;
  }
  if (claimedRaw !== null && lockIdentity(claimedRaw) === lockIdentity(provedRaw)) {
    try {
      fs.deleteSync(claimName);
    } catch {
      // silent: 并发回收已删除 —— corpse 消失即达成回收目标
    }
    return;
  }
  // 代际不匹配：恢复被误抢的新代 lock（O_EXCL 不覆盖更新一代）
  if (claimedRaw !== null) {
    try {
      fs.writeExclusiveSync(lockName, claimedRaw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new ConfigStoreError(
          'lock_indeterminate',
          `Config lock reclaim grabbed a newer generation and restore is blocked; ` +
          `evidence preserved at ${claimName}`,
          { cause: err },
        );
      }
      throw err;
    }
    try {
      fs.deleteSync(claimName);
    } catch {
      // silent: 恢复已完成，claim 副本残留无害（内容与原 lock 相同）
    }
    return;
  }
  // corpse 读不回 —— 无法判定代际也无法恢复内容，保留证据 fail-closed
  throw new ConfigStoreError(
    'lock_indeterminate',
    `Config lock corpse unreadable after claim; evidence preserved at ${claimName}`,
  );
}

async function acquireConfigLock(
  fs: FileSystem,
  lockName: string,
  opts: { acquireTimeoutMs: number; staleMs: number; pollMs: number },
): Promise<string> {
  const myToken = newShortUuid();
  const myPayload: ConfigLockPayload = {
    token: myToken,
    pid: process.pid,
    process_start_time: getProcessStartTime(process.pid),
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + opts.acquireTimeoutMs;
  for (;;) {
    try {
      fs.writeExclusiveSync(lockName, JSON.stringify(myPayload));
      return myToken;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }
    if (Date.now() >= deadline) {
      throw new ConfigStoreError(
        'lock_timeout',
        `Config lock acquire timeout: ${lockName} held by another process`,
      );
    }
    const observed = observeLock(fs, lockName);
    if (
      observed.kind === 'ok' &&
      isLockProbeDue(observed.payload, opts.staleMs) &&
      !isLockHolderAlive(observed.payload)
    ) {
      // holder 已被证明死亡（ESRCH / PID 回收）—— rename-claim 回收其 corpse
      await tryReclaimDeadHolder(fs, lockName, observed.raw);
      continue;
    }
    // absent / unreadable / malformed / 存活 / 未到探测窗口 —— 保守等待
    await new Promise<void>(resolve => setTimeout(resolve, opts.pollMs));
  }
}

/**
 * 释放：只删除自己持有的 token 代。锁已被替换/消失时显式 typed 'lock_lost'
 * 报告，绝不误删新 holder 的锁。
 */
function releaseConfigLock(fs: FileSystem, lockName: string, myToken: string): ConfigStoreError | null {
  const observed = observeLock(fs, lockName);
  if (observed.kind !== 'ok') {
    return new ConfigStoreError(
      'lock_lost',
      `Config lock ${lockName} ${observed.kind} at release; mutation outcome needs verification`,
    );
  }
  if (lockIdentity(observed.raw) !== `token:${myToken}`) {
    return new ConfigStoreError(
      'lock_lost',
      `Config lock ${lockName} was replaced during mutation; not deleting the new holder's lock`,
    );
  }
  try {
    fs.deleteSync(lockName);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null; // 锁已不在 —— 释放目标已达成
    return new ConfigStoreError(
      'lock_lost',
      `Config lock ${lockName} release failed: ${formatUnknownError(err)}`,
      { cause: err },
    );
  }
  return null;
}

/**
 * Phase 1910 Step D（RACE-CONFIG-READ-MODIFY-WRITE）：per-path 跨进程锁。
 *
 * 在锁内组合本模块既有同步原语（loadYamlConfig / writeYamlConfig /
 * patchYamlConfig），使 read→modify→write 整体串行化：任何成功提交的字段
 * 不会被另一成功 mutation 静默抹掉。锁文件为 `<config>.lock`，O_EXCL 创建裁决。
 * Phase 1911 Step C：holder 活性以 PID+进程启动时间证明，死亡才可回收
 * （rename-claim 原子抢占 + 代际复核）；释放只删自己持有的 token 代；
 * 获取超时 typed 'lock_timeout'，不可判状态 typed 'lock_indeterminate'，
 * 锁被替换 typed 'lock_lost'。锁不可重入、不可嵌套（CLI 一次性进程语义）。
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
  const myToken = await acquireConfigLock(fs, lockName, {
    acquireTimeoutMs: opts?.acquireTimeoutMs ?? CONFIG_LOCK_ACQUIRE_TIMEOUT_MS,
    staleMs: opts?.staleMs ?? CONFIG_LOCK_STALE_MS,
    pollMs: opts?.pollMs ?? CONFIG_LOCK_POLL_MS,
  });
  let fnThrew = false;
  let fnErr: unknown;
  try {
    fn();
  } catch (err) {
    // silent: fn 错误暂存，释放检查后原样重抛（不被释放问题掩盖）
    fnThrew = true;
    fnErr = err;
  }
  const releaseErr = releaseConfigLock(fs, lockName, myToken);
  if (fnThrew) throw fnErr;          // fn 的业务错误优先，不被释放问题掩盖
  if (releaseErr) throw releaseErr;  // fn 成功但锁完整性破坏 —— 显式报告
}
