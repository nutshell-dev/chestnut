/**
 * stop command - Stop all chestnut processes
 */

import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { getChestnutRoot, getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { getRelativeClawDir, type ClawId } from '../../foundation/claw-identity/index.js';
import {
  resolveClawDaemonDir,
  enumerateOrdinaryClaws,
  MOTION_CLAW_ID,
  requireMotionAccess,
} from '../../core/claw-topology/index.js';
import { getCapturedCliMotionAccess } from '../motion-cli-guard.js';
import { createWatchdogActionAudit } from '../../watchdog/index.js';
import { stopCommand as watchdogStop } from './watchdog-cli.js';
import { stopCommand as motionStop } from './motion.js';
import {
  PROCESS_MANAGER_AUDIT_EVENTS,
  createProcessManagerForCLI,
  DAEMON_SHUTDOWN_GRACE_MS,
  PROCESS_STOP_POLL_INTERVAL_MS,
  SIGKILL_DEAD_VERIFY_GRACE_MS,
  type StopProcessOutcome,
} from '../../foundation/process-manager/index.js';
import {
  kill,
  ProcessListUnavailable,
  captureProcessTarget,
  observePidArgv,
  observeProcessCwd,
  observeProcessTarget,
  terminateProcessTarget,
  observeProcessTargetWithLegacyProbeForTest,
  type ProcessEvidence,
  type ProcessTarget,
  type ProcessTargetObservation,
  type ProcessUnavailableReason,
} from '../../foundation/process-exec/index.js';
import { actionAuditFor, registerActionResource } from '../action-scope.js';
import type { AuditLog } from '../../foundation/audit/index.js';

import { resolveDaemonEntry } from '../../daemon/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { CliError } from '../errors.js';
import {
  commitCleanStopMarker,
  type CleanStopMarkerOutcome,
} from './clean-stop-marker.js';

interface StopCommandDeps {
  fsFactory(baseDir: string): FileSystem;
}

interface StopExtraDeps {
  audit?: AuditLog;
  kill?: typeof kill;
  isPidArgvMatching?: (pid: number, expectedToken: string) => boolean;
  isAlive?: (pid: number, expectedStartTime?: string) => boolean;
  captureTarget?: typeof captureProcessTarget;
  observeTarget?: typeof observeProcessTarget;
  observeCwd?: typeof observeProcessCwd;
  observeArgv?: typeof observePidArgv;
  canonicalizePath?: (targetPath: string) => string;
  terminateTarget?: typeof terminateProcessTarget;
}

type Attempt<T> = { ok: true; result: T } | { ok: false; error: unknown };

async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, result: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

interface DaemonObservationTools {
  captureTarget: typeof captureProcessTarget;
  observeTarget: typeof observeProcessTarget;
  observeCwd: typeof observeProcessCwd;
  observeArgv: typeof observePidArgv;
  canonicalizePath: (targetPath: string) => string;
}

type OwnedProcessTarget = ProcessTarget & {
  startTime: NonNullable<ProcessTarget['startTime']>;
};

type Ownership =
  | { kind: 'owned'; target: OwnedProcessTarget }
  | { kind: 'foreign' }
  | { kind: 'gone' }
  | { kind: 'unknown'; reason: string };

type WorkspaceObservation =
  | { kind: 'owned' | 'foreign'; evidence: ProcessEvidence }
  | { kind: 'gone' | 'unknown'; observation: ProcessTargetObservation };

function unknownObservation(
  reason: ProcessUnavailableReason,
  evidence: ProcessEvidence,
  error?: unknown,
): ProcessTargetObservation {
  return { kind: 'unknown', reason, evidence, ...(error !== undefined ? { error } : {}) };
}

function identityChangedIsUnknown(
  observation: ProcessTargetObservation,
): ProcessTargetObservation {
  return observation.kind === 'gone' && observation.reason === 'identity_changed'
    ? unknownObservation('identity_unverifiable', observation.evidence)
    : observation;
}

function observationReason(observation: ProcessTargetObservation): string {
  return observation.kind === 'unknown'
    ? `${observation.reason}${observation.error !== undefined ? `: ${formatErr(observation.error)}` : ''}`
    : observation.kind;
}

/** Check the shared entry and a recognized, adjacent daemon identity token. */
function observeDaemonArgv(
  target: OwnedProcessTarget,
  daemonEntry: string,
  clawNames: readonly string[],
  tools: DaemonObservationTools,
): ReturnType<typeof observePidArgv> {
  let last: ReturnType<typeof observePidArgv> | undefined;
  for (const identity of [MOTION_CLAW_ID, ...new Set(clawNames)]) {
    const observation = tools.observeArgv(target.pid, `${daemonEntry} ${identity}`);
    if (observation.kind !== 'mismatch') return observation;
    last = observation;
  }
  return last!;
}

async function observeDaemonWorkspace(
  target: OwnedProcessTarget,
  workspaceRoot: string,
  daemonEntry: string,
  clawNames: readonly string[],
  tools: DaemonObservationTools,
): Promise<WorkspaceObservation> {
  const argv = observeDaemonArgv(target, daemonEntry, clawNames, tools);
  if (argv.kind === 'gone') {
    return { kind: 'gone', observation: { kind: 'gone', reason: 'absent', evidence: argv.evidence } };
  }
  if (argv.kind !== 'match') {
    return {
      kind: 'unknown',
      observation: unknownObservation(
        argv.kind === 'unknown' ? argv.reason : 'incomplete_data',
        argv.evidence,
        argv.kind === 'unknown' ? argv.error : undefined,
      ),
    };
  }

  let evidence = argv.evidence;
  try {
    const cwd = await tools.observeCwd(target.pid);
    evidence = cwd.evidence;
    if (cwd.kind === 'unknown') {
      return { kind: 'unknown', observation: unknownObservation(cwd.reason, cwd.evidence) };
    }
    const canonicalWorkspace = tools.canonicalizePath(workspaceRoot);
    const canonicalCwd = tools.canonicalizePath(cwd.cwd);
    return {
      kind: canonicalWorkspace === canonicalCwd ? 'owned' : 'foreign',
      evidence,
    };
  } catch (error) {
    // silent: host query and canonicalization failures become typed unknown evidence.
    return {
      kind: 'unknown',
      observation: unknownObservation('query_failed', evidence, error),
    };
  }
}

async function classifyDaemonCandidate(
  pid: number,
  workspaceRoot: string,
  daemonEntry: string,
  clawNames: readonly string[],
  tools: DaemonObservationTools,
): Promise<Ownership> {
  const capture = tools.captureTarget(pid);
  if (capture.kind === 'gone') return { kind: 'gone' };
  if (capture.kind === 'unknown') {
    return {
      kind: 'unknown',
      reason: `capture ${capture.reason}${capture.error !== undefined ? `: ${formatErr(capture.error)}` : ''}`,
    };
  }
  if (capture.target.startTime === undefined) {
    return { kind: 'unknown', reason: 'capture incomplete_data: start time unavailable' };
  }

  const target: OwnedProcessTarget = {
    ...capture.target,
    startTime: capture.target.startTime,
    argvToken: daemonEntry,
  };
  const initial = identityChangedIsUnknown(tools.observeTarget(target));
  if (initial.kind === 'gone') return { kind: 'gone' };
  if (initial.kind === 'unknown') {
    return { kind: 'unknown', reason: `initial identity ${observationReason(initial)}` };
  }

  const workspace = await observeDaemonWorkspace(
    target, workspaceRoot, daemonEntry, clawNames, tools,
  );
  if (workspace.kind === 'gone') return { kind: 'gone' };
  if (workspace.kind === 'unknown') {
    return { kind: 'unknown', reason: `workspace ${observationReason(workspace.observation)}` };
  }

  const final = identityChangedIsUnknown(tools.observeTarget(target));
  if (final.kind === 'gone') return { kind: 'gone' };
  if (final.kind === 'unknown') {
    return { kind: 'unknown', reason: `final identity ${observationReason(final)}` };
  }
  return workspace.kind === 'foreign' ? { kind: 'foreign' } : { kind: 'owned', target };
}

/** Revalidate the captured identity before each TERM/KILL; foreign is never authorization. */
async function recheckDaemonWorkspace(
  target: ProcessTarget,
  workspaceRoot: string,
  daemonEntry: string,
  clawNames: readonly string[],
  tools: DaemonObservationTools,
): Promise<ProcessTargetObservation> {
  const initial = identityChangedIsUnknown(tools.observeTarget(target));
  if (initial.kind !== 'alive') return initial;
  const ownedTarget = target as OwnedProcessTarget;
  const workspace = await observeDaemonWorkspace(
    ownedTarget, workspaceRoot, daemonEntry, clawNames, tools,
  );
  if (workspace.kind === 'gone' || workspace.kind === 'unknown') return workspace.observation;
  if (workspace.kind === 'foreign') {
    return unknownObservation('identity_unverifiable', workspace.evidence);
  }
  return identityChangedIsUnknown(tools.observeTarget(target));
}

export async function stopAllCommand(
  deps: StopCommandDeps,
  extraDeps?: StopExtraDeps,
): Promise<void> {
  requireMotionAccess(getCapturedCliMotionAccess('stop'), 'stop', 'stop');

  // motion-level audit（α 模板复用 / 同 daemon-entry shim / fail-soft）
  let audit: AuditLog | null = extraDeps?.audit ?? null;
  if (!audit) {
    try {
      const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
      audit = actionAuditFor(motionDir, deps);
    } catch (err) {
      console.error('Failed to construct audit for stop command:', err);
      audit = null;
    }
  }

  const watchdogActionAudit = createWatchdogActionAudit(deps.fsFactory);
  const watchdogAuditScoped = registerActionResource(
    'watchdog-action-audit',
    () => watchdogActionAudit.dispose(),
  );
  const baseDir = getChestnutRoot();
  const workspaceRoot = path.dirname(baseDir);
  const stopErrors: unknown[] = [];
  const cleanupFailures: string[] = [];
  const markerOutcomes: CleanStopMarkerOutcome[] = [];
  const markerFailures: string[] = [];
  let disposeError: unknown;
  let disposeFailed = false;

  try {
    // Watchdog normal stop and orphan sweep are independent attempts. Discovery
    // below remains read-only even when either result blocks downstream stops.
    const watchdogAttempt = await attempt(() => watchdogStop(deps.fsFactory));
    if (!watchdogAttempt.ok) {
      cleanupFailures.push(`watchdog stop unknown: ${formatErr(watchdogAttempt.error)}`);
      stopErrors.push(watchdogAttempt.error);
    }

    const sweepAttempt = await attempt(async () => {
      const { sweepOrphanWatchdogs } = await import('../../watchdog/index.js');
      return sweepOrphanWatchdogs(deps.fsFactory, { excludePid: null }, {
        kill: extraDeps?.kill,
        ...(extraDeps?.isAlive !== undefined ? {
          observeProcessTarget: (target: { pid: number }) =>
            observeProcessTargetWithLegacyProbeForTest(target, {
              legacyProbe: extraDeps.isAlive!,
              argvMatch: (pid, token) => extraDeps.isPidArgvMatching?.(pid, token) ?? true,
            }),
        } : {}),
      });
    });
    const orphanSweep = sweepAttempt.ok
      ? sweepAttempt.result
      : {
          kind: 'blocked' as const,
          killed: [],
          skipped: [],
          failures: [{ stage: 'find' as const, error: sweepAttempt.error }],
        };
    if (!sweepAttempt.ok) {
      cleanupFailures.push(`watchdog sweep unknown: ${formatErr(sweepAttempt.error)}`);
      stopErrors.push(sweepAttempt.error);
    }
    if (orphanSweep.killed.length > 0) {
      console.log(
        `Cleaned up ${orphanSweep.killed.length} orphan watchdog process(es): ${orphanSweep.killed.join(', ')}`,
      );
    }
    if (orphanSweep.failures.length > 0) {
      console.warn(`Failed to confirm ${orphanSweep.failures.length} orphan watchdog stop(s)`);
      for (const failure of orphanSweep.failures) stopErrors.push(failure.error);
    }

    const downstreamBlocked = !watchdogAttempt.ok
      || !sweepAttempt.ok
      || orphanSweep.failures.length > 0;
    if (downstreamBlocked) {
      const error = new Error('downstream blocked: watchdog stop/sweep was not confirmed');
      cleanupFailures.push(error.message);
      stopErrors.push(error);
    }

    // Motion failure is independent from claw cleanup. An intent is not exit.
    const motionFailures: string[] = [];
    let motionOutcome: StopProcessOutcome['kind'] | 'not_attempted' = 'not_attempted';
    if (!downstreamBlocked) {
      const motionAttempt = await attempt(() => motionStop({ fsFactory: deps.fsFactory }));
      if (!motionAttempt.ok) {
        motionOutcome = 'failed';
        motionFailures.push(`failed: ${formatErr(motionAttempt.error)}`);
        stopErrors.push(motionAttempt.error);
      } else {
        motionOutcome = motionAttempt.result.kind;
        if (motionAttempt.result.kind === 'failed') {
          const error = new Error(
            `Motion stop failed (stage=${motionAttempt.result.stage}): ${motionAttempt.result.reason}`,
          );
          motionFailures.push(`failed: ${motionAttempt.result.stage}: ${motionAttempt.result.reason}`);
          stopErrors.push(motionAttempt.result.error ?? error);
        } else if (motionAttempt.result.kind === 'intent_recorded') {
          const error = new Error('Motion stop intent recorded; daemon exit not confirmed');
          motionFailures.push('intent_recorded: daemon exit not confirmed');
          stopErrors.push(error);
        }
      }
    }

    const pm = createProcessManagerForCLI({ fsFactory: deps.fsFactory, baseDir });
    let clawNames: ClawId[] = [];
    const clawEnumerationFailures: string[] = [];
    try {
      const baseFs = deps.fsFactory(baseDir);
      const { valid, invalid } = enumerateOrdinaryClaws(baseFs, 'claws');
      clawNames = valid;
      for (const { dir, reason } of invalid) {
        if (reason === 'reserved_motion') {
          console.warn(`[stop] Skipping reserved claw directory: ${dir}`);
        }
      }
    } catch (error) {
      if (!isFileNotFound(error)) {
        clawEnumerationFailures.push(formatErr(error));
        stopErrors.push(error);
        console.error(`[stop] readdirSync claws dir failed: ${(error as Error).message}`);
      }
    }

    const running = clawNames;
    const stopFailed: string[] = [];
    const clawIntents: string[] = [];
    const clawOutcomes = new Map<string, StopProcessOutcome['kind']>();
    const recordMarkerOutcome = (
      outcome: CleanStopMarkerOutcome,
      label: string,
      event: string,
      columns: string[],
    ): void => {
      markerOutcomes.push(outcome);
      if (outcome.kind === 'committed') return;
      const markerError = outcome.kind === 'not_attempted'
        ? { name: 'Error', message: 'marker write was not attempted' }
        : outcome.error;
      markerFailures.push(
        `${label} ${outcome.kind}: ${markerError.name}: ${markerError.message}`,
      );
      stopErrors.push(markerError);
      try {
        audit?.write(
          event,
          ...columns,
          `status=clean_stop_marker_${outcome.kind}`,
          `path=${outcome.path}`,
          `operation_id=${outcome.operationId}`,
          `error=${markerError.name}: ${markerError.message}`,
        );
      } catch (err) {
        markerFailures.push(`${label} marker audit failed: ${formatErr(err)}`);
        stopErrors.push(err);
      }
    };

    if (running.length > 0 && !downstreamBlocked) {
      console.log(`Stopping ${running.length} claw(s): ${running.join(', ')}...`);
      await Promise.all(running.map(async name => {
        try {
          const outcome = await pm.stop(resolveClawDaemonDir(name));
          clawOutcomes.set(name, outcome.kind);
          if (outcome.kind === 'failed') {
            const error = new Error(
              `stopProcess failed for ${name} (stage=${outcome.stage}): ${outcome.reason}`,
            );
            stopFailed.push(name);
            stopErrors.push(outcome.error ?? error);
            return;
          }
          if (outcome.kind === 'intent_recorded') {
            clawIntents.push(name);
            stopErrors.push(new Error(`${name}: stop intent recorded; daemon exit not confirmed`));
          }
        } catch (error) {
          // silent: each rejection is retained in the final aggregate while peers continue.
          clawOutcomes.set(name, 'failed');
          stopFailed.push(name);
          stopErrors.push(error);
        }
      }));
      if (stopFailed.length > 0 || clawIntents.length > 0) {
        console.warn(
          `Failed to confirm claw stop(s): ${[...stopFailed, ...clawIntents].join(', ')}`,
        );
      } else {
        console.log('All claws stopped');
      }
    }

    // Marker success never cancels a target or supervision failure.
    const baseFs = deps.fsFactory(baseDir);
    const globalMarker = await commitCleanStopMarker({
      scope: 'global',
      path: path.join(baseDir, 'clean-stop'),
      write: () => baseFs.writeAtomicSync('clean-stop', String(Date.now())),
    });
    recordMarkerOutcome(globalMarker, 'global', CLI_AUDIT_EVENTS.DAEMON_STOP, ['scope=all']);

    for (const [name, outcome] of clawOutcomes) {
      if (outcome !== 'stopped' && outcome !== 'not_running') continue;
      const clawDir = path.join(baseDir, getRelativeClawDir(name));
      const clawFs = deps.fsFactory(clawDir);
      const marker = await commitCleanStopMarker({
        scope: 'claw',
        path: path.join(clawDir, 'clean-stop'),
        write: () => clawFs.writeAtomicSync('clean-stop', String(Date.now())),
      });
      recordMarkerOutcome(marker, name, CLI_AUDIT_EVENTS.CLAW_STOP, [`name=${name}`]);
    }

    audit?.write(CLI_AUDIT_EVENTS.DAEMON_STOP, `scope=all`);

    // Daemon discovery is always attempted. Only identity, recognizable argv,
    // and canonical cwd jointly authorize termination of an owned candidate.
    try {
      const daemonEntryPath = resolveDaemonEntry();
      let pids: number[] = [];
      try {
        pids = pm.findProcessesSyncForCli(daemonEntryPath);
      } catch (error) {
        cleanupFailures.push(`daemon discovery unknown: ${formatErr(error)}`);
        stopErrors.push(error);
        audit?.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
          `context=stop_all_cleanup_pipeline`,
          `reason=${formatErr(error)}`,
          `error_type=${error instanceof ProcessListUnavailable ? 'ProcessListUnavailable' : 'unknown'}`,
        );
      }

      if (pids.length > 0) {
        console.log(`Discovered ${pids.length} orphan daemon candidate process(es)...`);
      }
      const tools: DaemonObservationTools = {
        captureTarget: extraDeps?.captureTarget ?? captureProcessTarget,
        observeTarget: extraDeps?.observeTarget ?? observeProcessTarget,
        observeCwd: extraDeps?.observeCwd ?? observeProcessCwd,
        observeArgv: extraDeps?.observeArgv ?? observePidArgv,
        canonicalizePath: extraDeps?.canonicalizePath
          ?? (targetPath => deps.fsFactory(targetPath).realpathSync('.')),
      };
      const terminateTarget = extraDeps?.terminateTarget ?? terminateProcessTarget;
      const killFn = extraDeps?.kill ?? kill;

      for (const pid of new Set(pids)) {
        if (downstreamBlocked) continue;
        try {
          const ownership = await classifyDaemonCandidate(
            pid, workspaceRoot, daemonEntryPath, clawNames, tools,
          );
          if (ownership.kind === 'foreign' || ownership.kind === 'gone') continue;
          if (ownership.kind === 'unknown') {
            const error = new Error(`Daemon candidate ${pid}: ${ownership.reason}`);
            cleanupFailures.push(error.message);
            stopErrors.push(error);
            continue;
          }

          const outcome = await terminateTarget(ownership.target, {
            graceMs: DAEMON_SHUTDOWN_GRACE_MS,
            confirmMs: SIGKILL_DEAD_VERIFY_GRACE_MS,
            pollIntervalMs: PROCESS_STOP_POLL_INTERVAL_MS,
            beforeSignal: target => recheckDaemonWorkspace(
              target, workspaceRoot, daemonEntryPath, clawNames, tools,
            ),
          }, {
            signal: killFn,
            observeTarget: target => tools.observeTarget(target),
          });
          if (outcome.kind === 'gone') continue;
          const outcomeStage = outcome.kind === 'still_alive' ? 'confirm' : outcome.stage;
          cleanupFailures.push(`daemon orphan ${pid}: ${outcome.kind}/${outcomeStage}`);
          stopErrors.push(outcome);
          if (outcome.kind === 'indeterminate' && outcome.stage === 'sigterm') {
            audit?.write(
              PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
              `pid=${pid}`,
              `context=stop_all_orphan_cleanup`,
              `reason=${formatErr(outcome.error)}`,
            );
            continue;
          }
          audit?.write(
            PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_CLEANUP_PARTIAL,
            `pids=${pid}`,
            `context=${outcome.kind === 'still_alive' ? 'stop_all_orphan_sigkill_survived' : 'stop_all_orphan_cleanup'}`,
            `stage=${outcomeStage}`,
            `reason=${outcome.kind === 'still_alive' ? 'process_survived_sigkill' : formatErr(outcome.error)}`,
            `evidence=${JSON.stringify(outcome.evidence)}`,
          );
          console.warn(`  WARNING: orphan ${pid} termination was not confirmed (${outcome.kind})`);
        } catch (error) {
          // One malformed/unavailable candidate must not suppress later candidates.
          cleanupFailures.push(`daemon orphan ${pid} unknown: ${formatErr(error)}`);
          stopErrors.push(error);
        }
      }
    } catch (error) {
      cleanupFailures.push(`daemon cleanup unknown: ${formatErr(error)}`);
      stopErrors.push(error);
      audit?.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
        `context=stop_all_cleanup_pipeline`,
        `reason=${formatErr(error)}`,
      );
    }

    if (
      motionFailures.length > 0
      || clawEnumerationFailures.length > 0
      || stopFailed.length > 0
      || clawIntents.length > 0
      || orphanSweep.failures.length > 0
      || markerFailures.length > 0
      || cleanupFailures.length > 0
    ) {
      const details = [
        ...(motionFailures.length > 0 ? [`motion ${motionOutcome}: ${motionFailures.join(', ')}`] : []),
        ...(clawEnumerationFailures.length > 0
          ? [`claw enumeration: ${clawEnumerationFailures.join(', ')}`]
          : []),
        ...(stopFailed.length > 0 ? [`claws failed: ${stopFailed.join(', ')}`] : []),
        ...(clawIntents.length > 0 ? [`claws intent_recorded: ${clawIntents.join(', ')}`] : []),
        ...(orphanSweep.failures.length > 0
          ? [`orphan watchdogs: ${orphanSweep.failures.map(f => f.pid ?? 'discovery').join(', ')}`]
          : []),
        ...(markerFailures.length > 0 ? [`clean-stop markers: ${markerFailures.join(', ')}`] : []),
        ...(cleanupFailures.length > 0 ? [`cleanup: ${cleanupFailures.join(', ')}`] : []),
      ];
      throw new CliError(`Failed to stop ${details.join('; ')}`, {
        code: 1,
        cause: new AggregateError(stopErrors),
      });
    }
  } finally {
    if (!watchdogAuditScoped) {
      try {
        await watchdogActionAudit.dispose();
      } catch (error) {
        // Never replace an in-flight terminal error with a disposal failure.
        disposeFailed = true;
        disposeError = error;
        console.error(`[stop] watchdog audit dispose failed: ${formatErr(error)}`);
      }
    }
  }

  if (disposeFailed) {
    throw new CliError(`Failed to stop cleanup: watchdog audit dispose: ${formatErr(disposeError)}`, {
      code: 1,
      cause: disposeError,
    });
  }
  console.log('Done.');
}
