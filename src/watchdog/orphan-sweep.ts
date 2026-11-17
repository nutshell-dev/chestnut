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
import { getAuditWriter, getChestnutFs } from './watchdog-context.js';
import { createWatchdogActionAudit } from './audit-wiring.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { observeWatchdogProcess, terminateWatchdogProcess, inspectWatchdogOwnerRecord } from './process-capabilities.js';
import {
  inspectWatchdogGenerationRecords,
  legacyParentMatchesInstance,
  type WatchdogGenerationRecord,
} from './watchdog-ownership.js';

export interface WatchdogOrphanInspectionDeps extends WatchdogProcessDeps {
  findProcessesAsync?: (entryPath: string) => Promise<number[]>;
}

export interface WatchdogOrphanEvidence {
  pid: number;
  observedAt: string;
  workspace: { kind: 'local' | 'foreign' | 'unknown'; root?: string };
  argv: { kind: 'match' | 'unknown' };
  generation: {
    kind: 'active' | 'candidate' | 'retired' | 'missing' | 'malformed';
    attemptId?: string;
    ownerToken?: string;
    recoveryWindowId?: string;
  };
  ppid: { kind: 'unknown'; reason: 'capability_unavailable' };
  processEvidence: unknown;
}

export type WatchdogOrphanDecision =
  | { kind: 'recovery'; pid: number; evidence: WatchdogOrphanEvidence }
  | {
      kind: 'blocked';
      pid?: number;
      reason: 'find_failed' | 'foreign_workspace' | 'identity_unknown' | 'workspace_unknown'
        | 'generation_unknown' | 'generation_malformed' | 'candidate_in_flight';
      evidence?: WatchdogOrphanEvidence;
      error?: unknown;
    };

export interface WatchdogOrphanInspectionReport {
  kind: 'clear' | 'recovery_required' | 'blocked';
  decisions: readonly WatchdogOrphanDecision[];
}

function inspectionEvidence(
  pid: number,
  record: WatchdogGenerationRecord | undefined,
  observation: unknown,
): WatchdogOrphanEvidence {
  let workspace: WatchdogOrphanEvidence['workspace'] = { kind: 'unknown' };
  if (record) {
    try {
      workspace = legacyParentMatchesInstance(record.owner.workspace_root)
        ? { kind: 'local', root: record.owner.workspace_root }
        : { kind: 'foreign', root: record.owner.workspace_root };
    } catch {
      workspace = { kind: 'unknown', root: record.owner.workspace_root };
    }
  }
  return {
    pid,
    observedAt: new Date().toISOString(),
    workspace,
    argv: { kind: 'match' },
    generation: record
      ? {
          kind: record.generation,
          attemptId: record.owner.attempt_id,
          ownerToken: record.owner.owner_token,
          ...(record.owner.recovery_window_id
            ? { recoveryWindowId: record.owner.recovery_window_id }
            : {}),
        }
      : { kind: 'missing' },
    ppid: { kind: 'unknown', reason: 'capability_unavailable' },
    processEvidence: observation,
  };
}

function auditOrphanInspection(decision: WatchdogOrphanDecision): void {
  const evidence = decision.evidence;
  getAuditWriter()?.write(
    decision.kind === 'recovery'
      ? WATCHDOG_AUDIT_EVENTS.ORPHAN_INSPECTION_RECOVERY
      : WATCHDOG_AUDIT_EVENTS.ORPHAN_INSPECTION_BLOCKED,
    `pid=${decision.pid ?? 'unknown'}`,
    `reason=${decision.kind === 'recovery' ? 'orphan_generation_matched' : decision.reason}`,
    `workspace=${evidence?.workspace.kind ?? 'unknown'}`,
    `workspace_root=${evidence?.workspace.root ?? 'unknown'}`,
    `argv=${evidence?.argv.kind ?? 'unknown'}`,
    `generation=${evidence?.generation.kind ?? 'unknown'}`,
    `attempt=${evidence?.generation.attemptId ?? 'unknown'}`,
    `recovery_window=${evidence?.generation.recoveryWindowId ?? 'none'}`,
    'ppid=unknown',
    ...(decision.kind === 'blocked' && decision.error
      ? [`error=${formatErr(decision.error)}`]
      : []),
    `evidence=${JSON.stringify(evidence?.processEvidence ?? null)}`,
  );
}

/** Read-only startup inspection. It never signals or mutates ownership records. */
export async function inspectOrphanWatchdogs(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogOrphanInspectionDeps,
): Promise<WatchdogOrphanInspectionReport> {
  const pm = createProcessManagerForCLI({ fsFactory, baseDir: getChestnutRoot() });
  let pids: number[];
  try {
    pids = await (deps?.findProcessesAsync
      ? deps.findProcessesAsync(getWatchdogEntryPath())
      : pm.findProcessesAsync(getWatchdogEntryPath()));
  } catch (error) {
    const decision = { kind: 'blocked', reason: 'find_failed', error } as const;
    auditOrphanInspection(decision);
    return { kind: 'blocked', decisions: [decision] };
  }

  const generations = inspectWatchdogGenerationRecords(getChestnutFs(fsFactory));
  const decisions: WatchdogOrphanDecision[] = [];
  for (const pid of pids) {
    const fact = observeWatchdogProcess(pid, deps);
    if (fact.kind === 'reclaimable') continue;
    if (fact.kind === 'indeterminate') {
      const evidence = inspectionEvidence(pid, undefined, fact.observation);
      evidence.argv = { kind: 'unknown' };
      decisions.push({ kind: 'blocked', pid, reason: 'identity_unknown', evidence, error: fact.observation.error });
      continue;
    }
    if (generations.kind === 'unknown') {
      decisions.push({
        kind: 'blocked', pid, reason: 'generation_malformed',
        evidence: inspectionEvidence(pid, undefined, fact.observation), error: generations.error,
      });
      continue;
    }
    const matches = generations.records.filter(record => record.owner.pid === pid);
    if (matches.length !== 1) {
      decisions.push({
        kind: 'blocked', pid, reason: 'generation_unknown',
        evidence: inspectionEvidence(pid, undefined, fact.observation),
      });
      continue;
    }
    const record = matches[0];
    const evidence = inspectionEvidence(pid, record, fact.observation);
    if (evidence.workspace.kind === 'foreign') {
      decisions.push({ kind: 'blocked', pid, reason: 'foreign_workspace', evidence });
      continue;
    }
    if (evidence.workspace.kind === 'unknown') {
      decisions.push({ kind: 'blocked', pid, reason: 'workspace_unknown', evidence });
      continue;
    }
    if (record.generation === 'candidate' && record.candidateOutcome === null) {
      decisions.push({ kind: 'blocked', pid, reason: 'candidate_in_flight', evidence });
      continue;
    }
    if (record.generation === 'active') {
      const active = inspectWatchdogOwnerRecord(record.owner, deps);
      if (active.kind === 'alive') continue;
      decisions.push({ kind: 'blocked', pid, reason: 'identity_unknown', evidence });
      continue;
    }
    const persisted = inspectWatchdogOwnerRecord(record.owner, deps);
    if (persisted.kind !== 'alive') {
      decisions.push({ kind: 'blocked', pid, reason: 'identity_unknown', evidence });
      continue;
    }
    decisions.push({ kind: 'recovery', pid, evidence });
  }
  for (const decision of decisions) auditOrphanInspection(decision);
  const kind = decisions.some(decision =>
    decision.kind === 'blocked'
    && decision.reason !== 'foreign_workspace'
    && decision.reason !== 'candidate_in_flight')
    ? 'blocked'
    : decisions.some(decision => decision.kind === 'recovery')
      ? 'recovery_required'
      : 'clear';
  return { kind, decisions };
}

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
    allPids = await pm.findProcessesAsync(wdPath);
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
    const fact = observeWatchdogProcess(pid, deps);
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
