/**
 * @module L6.Watchdog.OrphanSweep
 * 恢复 commit ece0926c + 4b5bf0b7 的 orphan sweep / 按 workspace root 精确化
 * （commit 16ba139b 当年删此逻辑改 isWatchdogAlive 幂等、phase 1269 实证假设破）
 */
import type { FileSystem } from '../foundation/fs/types.js';
import { formatErr } from "../foundation/utils/index.js";
import { kill as defaultKill, isAlive as defaultIsAlive } from '../foundation/process-exec/index.js';
import type { WatchdogProcessDeps } from './types.js';
import { createProcessManagerForCLI } from '../foundation/process-manager/index.js';
import { getWatchdogEntryPath } from './watchdog-context.js';
import { getWatchdogPid } from './watchdog-pid.js';
import { getAuditWriter } from './watchdog-context.js';
import { ensureAuditWired } from './audit-wiring.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';

const SWEEP_GRACE_MS = 1000;

/**
 * 扫 workspace 内所有 watchdog-entry.js 进程 / 排除 pid file 那个 / kill 余者。
 * 不跨 workspace（process_exec.findProcesses 按 entry path 精确匹配、entry path
 * 本身就 workspace-specific via getWatchdogEntryPath / dist path）
 */
export async function sweepOrphanWatchdogs(
  fsFactory: (baseDir: string) => FileSystem,
  opts: { excludePid?: number | null } = {},
  deps?: WatchdogProcessDeps,
): Promise<number[]> {
  ensureAuditWired(fsFactory);
  const pm = createProcessManagerForCLI({ fsFactory });
  const wdPath = getWatchdogEntryPath(fsFactory);
  // phase 220 Step C: distinguish `null` (explicit "no exclusion, kill all" — used by `stop`)
  // from `undefined` (omitted — fallback to pid-file owner). The previous `??` collapsed both
  // into the fallback, so even `excludePid: null` callers got `getWatchdogPid()`'s pid as
  // keepPid, which could accidentally match a target pid (real disk pid file leaked into the
  // test environment) and silently drop it from the kill list.
  const keepPid = opts.excludePid !== undefined ? opts.excludePid : getWatchdogPid(fsFactory);

  let allPids: number[];
  try {
    allPids = pm.findProcesses(wdPath);  // status.ts:71 同源
  } catch (err) {
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
      `phase=find`,
      `reason=${formatErr(err)}`,
    );
    return [];
  }

  const orphans = allPids.filter(p => p !== keepPid);
  if (orphans.length === 0) return [];

  const killed: number[] = [];
  for (const pid of orphans) {
    try {
      (deps?.kill ?? defaultKill)(pid, 'TERM');
      killed.push(pid);
    } catch (err) {
      const auditWriter = getAuditWriter();
      auditWriter?.write(
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
        `phase=sigterm`,
        `pid=${pid}`,
        `reason=${formatErr(err)}`,
      );
    }
  }

  if (killed.length > 0) {
    await new Promise(r => setTimeout(r, SWEEP_GRACE_MS));
    // SIGKILL 兜底
    for (const pid of killed) {
      if ((deps?.isAlive ?? defaultIsAlive)(pid)) {
        try { (deps?.kill ?? defaultKill)(pid, 'KILL'); } catch { /* silent: isAlive→SIGKILL race / 目标进程已死 ESRCH = 已达成目标态 */ }
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
