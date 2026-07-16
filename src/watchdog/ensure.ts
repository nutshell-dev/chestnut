/**
 * @module L6.Watchdog.Ensure
 * 「确保 watchdog 在运行」职责唯一入口 (M#1)
 * OS-level advisory lock 保 atomic check-and-spawn (M#9)
 */
import * as path from 'path';
import { makeChestnutRoot } from '../core/claw-topology/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { tryAcquireClaim, releaseClaim } from '../foundation/fs/lock-protocol.js';
import { isAlive, makeProcessStartTime } from '../foundation/process-exec/index.js';
import { getChestnutDir, getAuditWriter } from './watchdog-context.js';
import { isWatchdogAlive } from './watchdog-pid.js';
import { startCommand as rawStartCommand } from './watchdog-cli.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { ensureAuditWired } from './audit-wiring.js';
import { sweepOrphanWatchdogs as defaultSweep } from './orphan-sweep.js';
export { ensureAuditWired };

/**
 * Watchdog ensure_singleton lock 获取总 budget（ms）.
 * Derivation: 3s 给并发 ensure 调用足够等待先到者完成 spawn / kill stale 过程；
 * 配 LOCK_RETRY_INTERVAL_MS=50ms 共 ~60 retry / 远小于 user-perceived hang 上限.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 3000;

/**
 * Watchdog lock retry poll interval（ms）.
 * Derivation: 50ms = LOCK_ACQUIRE_TIMEOUT_MS / 60 retry / 不 busy-spin 也不漏窗.
 */
const LOCK_RETRY_INTERVAL_MS = 50;

/**
 * 锁文件内容：{ pid, startTime, ownerToken }。
 * ownerToken 使每次 tryAcquireLock 产生的锁全局唯一，避免 stale 判定/释放时的固定路径 TOCTOU。
 */
interface LockToken {
  pid: number;
  startTime: string;
  ownerToken: string;
}

/**
 * 唯一入口、所有 caller 必经此。
 * - foreign workspace → throw（caller 决定如何 surface）
 * - 已活 → no-op
 * - 未活 → 取 lock + spawn + 释放 lock
 */
type SweepFn = (
  fsFactory: (baseDir: string) => FileSystem,
  opts: { excludePid: number | null },
) => Promise<unknown>;

/**
 * 进程级单飞 promise：确保同一进程内并发 ensureWatchdog 调用只产生一次 spawn。
 * Per-contender 协议在 same-PID 并发时会将同进程其他 contender 的 claim 视为旧残留
 * 清理，导致多 spawn；用进程级序列化消除该竞态。
 */
let ensurePromise: Promise<void> | null = null;

export async function ensureWatchdog(
  fsFactory: (baseDir: string) => FileSystem,
  sweep: SweepFn = defaultSweep,
): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = ensureWatchdogInternal(fsFactory, sweep).finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

async function ensureWatchdogInternal(
  fsFactory: (baseDir: string) => FileSystem,
  sweep: SweepFn = defaultSweep,
): Promise<void> {
  ensureAuditWired(fsFactory);
  if (isWatchdogAlive(fsFactory)) return; // throws WatchdogPidForeignWorkspaceError if foreign

  const chestnutRoot = makeChestnutRoot(getChestnutDir());
  const fs = fsFactory(chestnutRoot);
  const relLockPath = 'watchdog.lock';
  const ownerToken = await tryAcquireLock(fs, relLockPath, LOCK_ACQUIRE_TIMEOUT_MS);
  if (ownerToken === null) {
    // 别 caller 持锁中、等其 spawn 完
    if (isWatchdogAlive(fsFactory)) return;
    const auditWriter = getAuditWriter();
    // phase 698: 加 path col、与同 fn ENSURE_LOCK_STALE_RECOVERED (L84 'path=relLockPath') 形态对齐
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_TIMEOUT,
      `path=${relLockPath}`,
      `timeout_ms=${LOCK_ACQUIRE_TIMEOUT_MS}`,
    );
    throw new Error(`Failed to acquire watchdog lock after ${LOCK_ACQUIRE_TIMEOUT_MS}ms`);
  }
  try {
    // double-check under lock
    if (!isWatchdogAlive(fsFactory)) {
      // phase 1269 sub-4: sweep stray watchdogs 先 (commit ece0926c 精确化恢复)
      // 防 silent removal / TOCTOU / crash 残留 → pid 0 但进程在
      await sweep(fsFactory, { excludePid: null });
      await rawStartCommand(fsFactory);
    }
  } finally {
    releaseLock(fs, relLockPath, ownerToken);
  }
}

async function tryAcquireLock(fs: FileSystem, relLockPath: string, timeoutMs: number): Promise<string | null> {
  // relLockPath = 'watchdog.lock' → lockDir = '.'
  const lockDir = path.dirname(relLockPath) || '.';
  const claimsDir = `${lockDir}/watchdog-lock/claims`;
  const deadline = Date.now() + timeoutMs;

  // 旧格式兼容：首次发现旧 watchdog.lock 时做一次性迁移
  await migrateLegacyWatchdogLock(fs, relLockPath);
  await fs.ensureDir(claimsDir);

  while (Date.now() < deadline) {
    const auditWriter = getAuditWriter();
    const ownerToken = await tryAcquireClaim(
      { fs, audit: auditWriter ?? undefined },
      `${lockDir}/watchdog-lock`,
    );
    if (ownerToken !== null) return ownerToken;
    await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
  }
  return null;
}

async function migrateLegacyWatchdogLock(fs: FileSystem, relLockPath: string): Promise<void> {
  const exists = await fs.exists(relLockPath).catch(() => false);
  if (!exists) return;
  const lockDir = path.dirname(relLockPath) || '.';
  const claimsDir = `${lockDir}/watchdog-lock/claims`;
  const claimsExist = await fs.exists(claimsDir).catch(() => false);
  if (claimsExist) {
    // 已迁移，删旧文件
    try { fs.deleteSync(relLockPath); } catch { /* silent: 旧锁清理 best-effort */ }
    return;
  }
  // 读旧锁判活 → dead 则删旧锁 + 创建 claims/
  const token = readLockToken(fs, relLockPath);
  if (token !== null && isAlive(token.pid, makeProcessStartTime(token.startTime))) {
    return; // 存活 → 不动旧锁
  }
  // dead/旧格式 → 删旧锁
  try { fs.deleteSync(relLockPath); } catch { /* silent: 旧锁清理 best-effort */ }
  const auditWriter = getAuditWriter();
  auditWriter?.write(WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_STALE_RECOVERED, `path=${relLockPath}`);
  await fs.ensureDir(claimsDir);
}

function readLockToken(fs: FileSystem, relLockPath: string): LockToken | null {
  try {
    const content = fs.readSync(relLockPath).trim();
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { pid: unknown }).pid !== 'number' ||
      typeof (parsed as { ownerToken: unknown }).ownerToken !== 'string'
    ) {
      return null;
    }
    const token = parsed as { pid: number; startTime?: unknown; ownerToken: string };
    return {
      pid: token.pid,
      startTime: typeof token.startTime === 'string' ? token.startTime : '0',
      ownerToken: token.ownerToken,
    };
  } catch {
    return null; // 旧格式 / 损坏 / 并发 unlink — 调用方按 reclaim 处理
  }
}

function releaseLock(fs: FileSystem, relLockPath: string, ownerToken: string): void {
  const lockDir = path.dirname(relLockPath) || '.';
  releaseClaim({ fs }, `${lockDir}/watchdog-lock`, ownerToken).catch(() => {
    // silent: release best-effort，已释放或并发清理均视为 no-op
  });
}
