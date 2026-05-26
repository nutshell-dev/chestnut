/**
 * @module L6.Watchdog.Ensure
 * 「确保 watchdog 在运行」职责唯一入口 (ML#1)
 * OS-level advisory lock 保 atomic check-and-spawn (ML#9)
 */
import type { FileSystem } from '../foundation/fs/types.js';
import { getClawforumDir, getAuditWriter } from './watchdog-context.js';
import { isWatchdogAlive } from './watchdog-pid.js';
import { startCommand as rawStartCommand } from './watchdog-cli.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { ensureAuditWired } from './audit-wiring.js';
export { ensureAuditWired };

const LOCK_ACQUIRE_TIMEOUT_MS = 3000;
const LOCK_RETRY_INTERVAL_MS = 50;

/**
 * 唯一入口、所有 caller 必经此。
 * - foreign workspace → throw（caller 决定如何 surface）
 * - 已活 → no-op
 * - 未活 → 取 lock + spawn + 释放 lock
 */
export async function ensureWatchdog(fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  ensureAuditWired(fsFactory);
  if (isWatchdogAlive(fsFactory)) return; // throws WatchdogPidForeignWorkspaceError if foreign

  const clawforumDir = getClawforumDir();
  const fs = fsFactory(clawforumDir);
  const relLockPath = 'watchdog.lock';
  const acquired = await tryAcquireLock(fs, relLockPath, LOCK_ACQUIRE_TIMEOUT_MS);
  if (!acquired) {
    // 别 caller 持锁中、等其 spawn 完
    if (isWatchdogAlive(fsFactory)) return;
    const auditWriter = getAuditWriter();
    auditWriter?.write(WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_TIMEOUT, `timeout_ms=${LOCK_ACQUIRE_TIMEOUT_MS}`);
    throw new Error(`Failed to acquire watchdog lock after ${LOCK_ACQUIRE_TIMEOUT_MS}ms`);
  }
  try {
    // double-check under lock
    if (!isWatchdogAlive(fsFactory)) {
      // phase 1269 sub-4: sweep stray watchdogs 先 (commit ece0926c 精确化恢复)
      // 防 silent removal / TOCTOU / crash 残留 → pid 0 但进程在
      const { sweepOrphanWatchdogs } = await import('./orphan-sweep.js');
      await sweepOrphanWatchdogs(fsFactory, { excludePid: null });
      await rawStartCommand(fsFactory);
    }
  } finally {
    releaseLock(fs, relLockPath);
  }
}

async function tryAcquireLock(fs: FileSystem, relLockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // writeExclusiveSync atomic claim (throws EEXIST if already exists)
      fs.writeExclusiveSync(relLockPath, `${process.pid}\n`);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // 检查 lock 持有者是否还活、stale 则清
      if (isLockStale(fs, relLockPath)) {
        try { fs.deleteSync(relLockPath); } catch { /* silent: stale-lock cleanup 与并发 unlink race / loser ENOENT 视为 winner 已清 / 外层 continue retry 收敛 */ }
        const auditWriter = getAuditWriter();
        auditWriter?.write(WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_STALE_RECOVERED, `path=${relLockPath}`);
        continue;
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
    }
  }
  return false;
}

function isLockStale(fs: FileSystem, relLockPath: string): boolean {
  try {
    const content = fs.readSync(relLockPath).trim();
    const pid = parseInt(content, 10);
    if (Number.isNaN(pid)) return true;
    try { process.kill(pid, 0); return false; } catch { return true; }
  } catch {
    return false; // 读不到、保守视为非 stale (concurrent unlink)
  }
}

function releaseLock(fs: FileSystem, relLockPath: string): void {
  try { fs.deleteSync(relLockPath); } catch { /* silent: release-lock idempotent / stale-recover 路径已先 unlink 时 ENOENT 合规 */ }
}
