/**
 * @module L6.Watchdog.OrphanSweep
 * 恢复 commit ece0926c + 4b5bf0b7 的 orphan sweep / 按 workspace root 精确化
 * （commit 16ba139b 当年删此逻辑改 isWatchdogAlive 幂等、phase 1269 实证假设破）
 */
import { kill, isAlive } from '../foundation/process-exec/index.js';
import { createProcessManagerForCLI } from '../cli/utils/factories.js';
import { getWatchdogEntryPath } from './watchdog-context.js';
import { getWatchdogPid } from './watchdog-pid.js';
import { getAuditWriter } from './watchdog-context.js';
import { ensureAuditWired } from './ensure.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';

const SWEEP_GRACE_MS = 1000;

/**
 * 扫 workspace 内所有 watchdog-entry.js 进程 / 排除 pid file 那个 / kill 余者。
 * 不跨 workspace（process_exec.findProcesses 按 entry path 精确匹配、entry path
 * 本身就 workspace-specific via getWatchdogEntryPath / dist path）
 */
export async function sweepOrphanWatchdogs(opts: { excludePid?: number | null } = {}): Promise<number[]> {
  ensureAuditWired();
  const pm = createProcessManagerForCLI();
  const wdPath = getWatchdogEntryPath();
  const keepPid = opts.excludePid ?? getWatchdogPid();  // 默认保 pid file 那个

  let allPids: number[];
  try {
    allPids = pm.findProcesses(wdPath);  // status.ts:71 同源
  } catch (err) {
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
      `phase=find`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const orphans = allPids.filter(p => p !== keepPid);
  if (orphans.length === 0) return [];

  const killed: number[] = [];
  for (const pid of orphans) {
    try {
      kill(pid, 'TERM');
      killed.push(pid);
    } catch (err) {
      const auditWriter = getAuditWriter();
      auditWriter?.write(
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
        `phase=sigterm`,
        `pid=${pid}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (killed.length > 0) {
    await new Promise(r => setTimeout(r, SWEEP_GRACE_MS));
    // SIGKILL 兜底
    for (const pid of killed) {
      if (isAlive(pid)) {
        try { kill(pid, 'KILL'); } catch { /* dead now */ }
      }
    }
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED,
      `count=${killed.length}`,
      `pids=${killed.join(',')}`,
      `kept=${keepPid ?? 'none'}`,
    );
  }
  return killed;
}
