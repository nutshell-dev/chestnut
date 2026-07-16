/**
 * @module L6.Watchdog.Ensure
 * 「确保 watchdog 在运行」职责唯一入口 (M#1)
 * OS-level advisory lock 保 atomic check-and-spawn (M#9)
 */
import { makeChestnutRoot } from '../core/claw-topology/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { newShortUuid } from '../foundation/node-utils/index.js';
import { isAlive, getProcessStartTime, makeProcessStartTime } from '../foundation/process-exec/index.js';
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

export async function ensureWatchdog(
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
  const ownerToken = newShortUuid();
  const startTime = getProcessStartTime(process.pid) ?? '0';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // writeExclusiveSync atomic claim (throws EEXIST if already exists)
      fs.writeExclusiveSync(relLockPath, JSON.stringify({
        pid: process.pid,
        startTime,
        ownerToken,
      }));
      return ownerToken;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // 检查 lock 持有者是否还活；stale / 旧格式 / 无法解析 则清掉重试
      const token = readLockToken(fs, relLockPath);
      if (token !== null) {
        const holderAlive = isAlive(token.pid, makeProcessStartTime(token.startTime));
        if (holderAlive) {
          await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
          continue;
        }
        // Stale holder is dead → reclaim. 读→删之间仍可能被替换，但下一轮 retry 会自我纠正。
      }
      try { fs.deleteSync(relLockPath); } catch { /* silent: stale-lock cleanup 与并发 unlink race / loser ENOENT 视为 winner 已清 / 外层 continue retry 收敛 */ }
      const auditWriter = getAuditWriter();
      auditWriter?.write(WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_STALE_RECOVERED, `path=${relLockPath}`);
      continue;
    }
  }
  return null;
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
  try {
    const token = readLockToken(fs, relLockPath);
    if (token === null || token.ownerToken !== ownerToken) return; // lock replaced by another caller / already released
    fs.deleteSync(relLockPath);
  } catch {
    // silent: ENOENT / corrupt lock on release — idempotent fail-soft
  }
}
