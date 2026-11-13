/**
 * @module L6.Watchdog.OrphanSweep
 * Watchdog owns orphan candidacy and audit; ProcessExec owns OS termination facts.
 */
import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import type { ProcessTerminationOutcome } from '../foundation/process-exec/index.js';
import type { WatchdogProcessDeps } from './types.js';
import { createProcessManagerForCLI } from '../foundation/process-manager/index.js';
import { getChestnutRoot } from '../foundation/claw-identity/index.js';
import { getWatchdogEntryPath } from './watchdog-context.js';
import { getWatchdogPid } from './watchdog-pid.js';
import { getAuditWriter } from './watchdog-context.js';
import { createWatchdogActionAudit } from './audit-wiring.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { observeWatchdogProcess, terminateWatchdogProcess } from './process-capabilities.js';

const SWEEP_GRACE_MS = 1000;
const SWEEP_CONFIRM_MS = 1000;
const SWEEP_POLL_MS = 100;

export interface WatchdogOrphanFailure {
  pid?: number;
  stage: 'find' | 'observe' | 'sigterm' | 'sigkill' | 'confirm';
  error: unknown;
  outcome?: ProcessTerminationOutcome;
}

export type WatchdogOrphanSweepOutcome =
  | { kind: 'clear'; killed: number[]; skipped: number[]; failures: [] }
  | {
      kind: 'partial' | 'blocked';
      killed: number[];
      skipped: number[];
      failures: WatchdogOrphanFailure[];
    };

/**
 * Sweep this installation's orphan watchdogs. `killed` contains only targets
 * confirmed gone after a stop attempt; signal issuance alone is not success.
 */
export async function sweepOrphanWatchdogs(
  fsFactory: (baseDir: string) => FileSystem,
  opts: { excludePid?: number | null } = {},
  deps?: WatchdogProcessDeps,
): Promise<WatchdogOrphanSweepOutcome> {
  const actionAudit = createWatchdogActionAudit(fsFactory);
  try {
    return await sweepOrphanWatchdogsScoped(fsFactory, opts, deps);
  } finally {
    actionAudit.dispose();
  }
}

function outcomeKind(
  killed: number[],
  failures: WatchdogOrphanFailure[],
): WatchdogOrphanSweepOutcome['kind'] {
  if (failures.length === 0) return 'clear';
  return killed.length > 0 ? 'partial' : 'blocked';
}

async function sweepOrphanWatchdogsScoped(
  fsFactory: (baseDir: string) => FileSystem,
  opts: { excludePid?: number | null } = {},
  deps?: WatchdogProcessDeps,
): Promise<WatchdogOrphanSweepOutcome> {
  const baseDir = getChestnutRoot();
  const pm = createProcessManagerForCLI({ fsFactory, baseDir });
  const wdPath = getWatchdogEntryPath();
  const keepPid = opts.excludePid !== undefined ? opts.excludePid : getWatchdogPid(fsFactory);

  let allPids: number[];
  try {
    allPids = pm.findProcesses(wdPath);
  } catch (error) {
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
      'phase=find',
      `reason=${formatErr(error)}`,
    );
    return {
      kind: 'blocked', killed: [], skipped: [],
      failures: [{ stage: 'find', error }],
    };
  }

  const orphans = allPids.filter(pid => pid !== keepPid);
  const killed: number[] = [];
  const skipped: number[] = [];
  const failures: WatchdogOrphanFailure[] = [];

  for (const pid of orphans) {
    const fact = observeWatchdogProcess(pid, undefined, deps);
    if (fact.kind === 'reclaimable') {
      skipped.push(pid);
      if (fact.reason === 'identity_changed') {
        getAuditWriter()?.write(
          WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_PID_REUSE_SKIPPED,
          `pid=${pid}`,
          'reason=argv_not_watchdog',
        );
      }
      continue;
    }
    if (fact.kind === 'indeterminate') {
      const error = fact.observation.error ?? fact.observation;
      failures.push({ pid, stage: 'observe', error });
      getAuditWriter()?.write(
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
        'phase=observe',
        `pid=${pid}`,
        `reason=${fact.observation.reason}`,
        `evidence=${JSON.stringify(fact.observation.evidence)}`,
      );
      continue;
    }

    const outcome = await terminateWatchdogProcess(fact.target, {
      graceMs: SWEEP_GRACE_MS,
      confirmMs: SWEEP_CONFIRM_MS,
      pollIntervalMs: SWEEP_POLL_MS,
    }, deps);
    if (outcome.kind === 'gone') {
      if (outcome.via !== 'already_gone' && outcome.termSent) killed.push(pid);
      else skipped.push(pid);
      continue;
    }

    const stage = outcome.kind === 'still_alive' ? 'confirm' : outcome.stage;
    const error = outcome.kind === 'still_alive'
      ? new Error(`orphan watchdog survived SIGKILL: ${pid}`)
      : outcome.error;
    failures.push({ pid, stage, error, outcome });
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
      `phase=${stage}`,
      `pid=${pid}`,
      `reason=${formatErr(error)}`,
      `evidence=${JSON.stringify(outcome.evidence)}`,
    );
  }

  if (killed.length > 0) {
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED,
      `count=${killed.length}`,
      `pids=${killed.join(',')}`,
      `kept=${keepPid ?? 'none'}`,
    );
  }
  const kind = outcomeKind(killed, failures);
  return kind === 'clear'
    ? { kind, killed, skipped, failures: [] }
    : { kind, killed, skipped, failures };
}
