/**
 * @module L6.Watchdog.Ensure
 * 「确保 watchdog 在运行」职责唯一入口 (ML#1)
 * OS-level advisory lock 保 atomic check-and-spawn (ML#9)
 */
import * as fsNode from 'node:fs';
import * as path from 'node:path';
import { createAuditWriter } from '../foundation/audit/index.js';
import { getClawforumDir, getClawforumFs, getGlobalConfig, getAuditWriter, setAuditWriter } from './watchdog-context.js';
import { isWatchdogAlive } from './watchdog-pid.js';
import { startCommand as rawStartCommand } from './watchdog-cli.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';

const LOCK_ACQUIRE_TIMEOUT_MS = 3000;
const LOCK_RETRY_INTERVAL_MS = 50;

/**
 * Lazy-init workspace audit writer for CLI-side watchdog operations.
 * No-op if already wired (e.g. daemon process that called setAuditWriter).
 * Fail-soft: logs to console on error, never throws.
 */
export function ensureAuditWired(): void {
  if (getAuditWriter() !== null) return;
  try {
    const auditMaxSizeMb = getGlobalConfig().audit?.retention?.max_size_mb ?? null;
    const auditWriter = createAuditWriter(getClawforumFs(), 'audit.tsv', auditMaxSizeMb);
    setAuditWriter(auditWriter);
  } catch (err) {
    console.error('Failed to wire watchdog audit in CLI:', err);
  }
}

/**
 * 唯一入口、所有 caller 必经此。
 * - foreign workspace → throw（caller 决定如何 surface）
 * - 已活 → no-op
 * - 未活 → 取 lock + spawn + 释放 lock
 */
export async function ensureWatchdog(): Promise<void> {
  ensureAuditWired();
  if (isWatchdogAlive()) return; // throws WatchdogPidForeignWorkspaceError if foreign

  const lockPath = path.join(getClawforumDir(), 'watchdog.lock');
  const acquired = await tryAcquireLock(lockPath, LOCK_ACQUIRE_TIMEOUT_MS);
  if (!acquired) {
    // 别 caller 持锁中、等其 spawn 完
    if (isWatchdogAlive()) return;
    const auditWriter = getAuditWriter();
    auditWriter?.write(WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_TIMEOUT, `timeout_ms=${LOCK_ACQUIRE_TIMEOUT_MS}`);
    throw new Error(`Failed to acquire watchdog lock after ${LOCK_ACQUIRE_TIMEOUT_MS}ms`);
  }
  try {
    // double-check under lock
    if (!isWatchdogAlive()) {
      // phase 1269 sub-4: sweep stray watchdogs 先 (commit ece0926c 精确化恢复)
      // 防 silent removal / TOCTOU / crash 残留 → pid 0 但进程在
      const { sweepOrphanWatchdogs } = await import('./orphan-sweep.js');
      await sweepOrphanWatchdogs({ excludePid: null });
      await rawStartCommand();
    }
  } finally {
    releaseLock(lockPath);
  }
}

async function tryAcquireLock(lockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // O_EXCL + O_CREAT atomic claim
      const fd = fsNode.openSync(lockPath, fsNode.constants.O_CREAT | fsNode.constants.O_EXCL | fsNode.constants.O_WRONLY, 0o644);
      fsNode.writeSync(fd, `${process.pid}\n`);
      fsNode.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // 检查 lock 持有者是否还活、stale 则清
      if (isLockStale(lockPath)) {
        try { fsNode.unlinkSync(lockPath); } catch { /* race ok */ }
        const auditWriter = getAuditWriter();
        auditWriter?.write(WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_STALE_RECOVERED, `path=${lockPath}`);
        continue;
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
    }
  }
  return false;
}

function isLockStale(lockPath: string): boolean {
  try {
    const content = fsNode.readFileSync(lockPath, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (Number.isNaN(pid)) return true;
    try { process.kill(pid, 0); return false; } catch { return true; }
  } catch {
    return false; // 读不到、保守视为非 stale (concurrent unlink)
  }
}

function releaseLock(lockPath: string): void {
  try { fsNode.unlinkSync(lockPath); } catch { /* 已被 stale recover 清 ok */ }
}
