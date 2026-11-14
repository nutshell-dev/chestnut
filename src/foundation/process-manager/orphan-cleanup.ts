/**
 * Durable, restartable orphan-cleanup orchestration.
 *
 * ProcessExec owns host enumeration, literal argv matching and signals. This
 * module only persists the cleanup request/outcome and applies the spawn gate's
 * recovery policy. A blocked attempt stays in active/ and the next spawn retries
 * it with the same request id; a completed attempt is moved to retired/<id>/.
 */
import * as path from 'path';
import { formatErr, newUuid } from '../node-utils/index.js';
import { isFileNotFound } from '../fs/index.js';
import {
  terminateMatchingProcesses,
  type ProcessInfo,
  type ProcessMatchCleanupOutcome,
} from '../process-exec/index.js';
import { DAEMON_SHUTDOWN_GRACE_MS } from './constants.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { findProcessesDetailedAsync } from './find.js';
import { STATUS_SUBDIR } from './paths.js';
import type {
  DaemonDir,
  OrphanCleanupStage,
  ProcessManagerContext,
  SpawnOptions,
} from './types.js';

const SCHEMA_VERSION = 1;
const ROOT_DIR = 'orphan-cleanup';
const ACTIVE_DIR = 'active';
const RETIRED_DIR = 'retired';
const INTENT_FILE = 'intent.json';
const OUTCOME_FILE = 'outcome.json';

interface OrphanCleanupIntent {
  schema_version: 1;
  request_id: string;
  daemon_dir: string;
  command: string;
  args: string[];
  created_at: string;
}

interface OrphanCleanupOutcomeRecord {
  schema_version: 1;
  request_id: string;
  completed_at: string;
  outcome: 'clear' | 'not_needed' | 'blocked';
  terminated: number;
  pids: number[];
  skipped: number[];
  stage?: 'enumerate' | 'signal' | 'verify';
  error?: unknown;
}

export interface OrphanCleanupAdapters {
  /** Deterministic query seam for recovery tests; production uses bounded L1 listing. */
  list?: () => Promise<ProcessInfo[]>;
}

export type OrphanCleanupRun =
  | { kind: 'clear'; terminated: number; requestId: string; recovered: boolean }
  | { kind: 'not_needed'; requestId: string; recovered: boolean }
  | {
      kind: 'blocked';
      stage: OrphanCleanupStage;
      error: unknown;
      pids: number[];
      requestId?: string;
      recovered: boolean;
    };

type CleanupAttempt =
  | { kind: 'ready'; intent: OrphanCleanupIntent; recovered: boolean }
  | { kind: 'blocked'; error: unknown; requestId?: string; recovered: boolean };

function rootDir(daemonDir: DaemonDir): string {
  return path.join(daemonDir, STATUS_SUBDIR, 'process', ROOT_DIR);
}

export function getOrphanCleanupActiveDir(daemonDir: DaemonDir): string {
  return path.join(rootDir(daemonDir), ACTIVE_DIR);
}

export function getOrphanCleanupRetiredDir(daemonDir: DaemonDir, requestId: string): string {
  return path.join(rootDir(daemonDir), RETIRED_DIR, requestId);
}

function intentPath(daemonDir: DaemonDir): string {
  return path.join(getOrphanCleanupActiveDir(daemonDir), INTENT_FILE);
}

function outcomePath(daemonDir: DaemonDir): string {
  return path.join(getOrphanCleanupActiveDir(daemonDir), OUTCOME_FILE);
}

function isIntent(value: unknown): value is OrphanCleanupIntent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<OrphanCleanupIntent>;
  return record.schema_version === SCHEMA_VERSION
    && typeof record.request_id === 'string' && record.request_id.length > 0
    && typeof record.daemon_dir === 'string' && record.daemon_dir.length > 0
    && typeof record.command === 'string' && record.command.length > 0
    && Array.isArray(record.args) && record.args.every(arg => typeof arg === 'string')
    && typeof record.created_at === 'string';
}

function isOutcome(value: unknown): value is OrphanCleanupOutcomeRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<OrphanCleanupOutcomeRecord>;
  return record.schema_version === SCHEMA_VERSION
    && typeof record.request_id === 'string' && record.request_id.length > 0
    && typeof record.completed_at === 'string'
    && (record.outcome === 'clear' || record.outcome === 'not_needed' || record.outcome === 'blocked')
    && typeof record.terminated === 'number' && Number.isSafeInteger(record.terminated)
    && Array.isArray(record.pids) && record.pids.every(pid => Number.isSafeInteger(pid) && pid > 0)
    && Array.isArray(record.skipped) && record.skipped.every(pid => Number.isSafeInteger(pid) && pid > 0);
}

function sameRequest(intent: OrphanCleanupIntent, daemonDir: DaemonDir, options: SpawnOptions): boolean {
  return intent.daemon_dir === daemonDir
    && intent.command === options.command
    && intent.args.length === options.args.length
    && intent.args.every((arg, index) => arg === options.args[index]);
}

function readIntent(ctx: ProcessManagerContext, daemonDir: DaemonDir): OrphanCleanupIntent {
  const raw = ctx.fs.readSync(intentPath(daemonDir));
  const parsed: unknown = JSON.parse(raw);
  if (!isIntent(parsed)) throw new Error('orphan cleanup intent shape mismatch');
  return parsed;
}

function readCompletedOutcome(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  requestId: string,
): OrphanCleanupOutcomeRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(ctx.fs.readSync(outcomePath(daemonDir)));
    if (!isOutcome(parsed) || parsed.request_id !== requestId) {
      throw new Error('orphan cleanup outcome shape or request mismatch');
    }
    return parsed;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

function beginAttempt(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  options: SpawnOptions,
): CleanupAttempt {
  let recovered = ctx.fs.existsSync(intentPath(daemonDir));
  let intent: OrphanCleanupIntent;
  try {
    if (recovered) {
      intent = readIntent(ctx, daemonDir);
    } else {
      intent = {
        schema_version: SCHEMA_VERSION,
        request_id: newUuid(),
        daemon_dir: daemonDir,
        command: options.command,
        args: [...options.args],
        created_at: new Date().toISOString(),
      };
      try {
        ctx.fs.ensureDirSync(getOrphanCleanupActiveDir(daemonDir));
        ctx.fs.writeExclusiveSync(intentPath(daemonDir), JSON.stringify(intent, null, 2));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        intent = readIntent(ctx, daemonDir);
        recovered = true;
      }
    }
  } catch (error) {
    // silent: malformed or unreadable recovery state blocks spawning with its cause.
    return { kind: 'blocked', error, recovered };
  }
  if (!sameRequest(intent, daemonDir, options)) {
    return {
      kind: 'blocked',
      error: new Error('active orphan cleanup request identity does not match this spawn'),
      requestId: intent.request_id,
      recovered: true,
    };
  }
  return { kind: 'ready', intent, recovered };
}

function serializeError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return { value: String(error) };
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    evidence?: unknown;
  };
  return {
    name: typeof candidate.name === 'string' ? candidate.name : 'Error',
    message: typeof candidate.message === 'string' ? candidate.message : formatErr(error),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(candidate.evidence !== undefined ? { evidence: candidate.evidence } : {}),
  };
}

function outcomeRecord(
  requestId: string,
  outcome: ProcessMatchCleanupOutcome,
): OrphanCleanupOutcomeRecord {
  const base = {
    schema_version: 1 as const,
    request_id: requestId,
    completed_at: new Date().toISOString(),
    terminated: outcome.kind === 'clear' ? outcome.terminated : 0,
    pids: outcome.kind === 'not_needed' ? [] : [...outcome.pids],
    skipped: outcome.kind === 'blocked' ? [] : [...outcome.skipped],
  };
  if (outcome.kind === 'blocked') {
    return {
      ...base,
      outcome: 'blocked',
      stage: outcome.stage,
      error: serializeError(outcome.error),
    };
  }
  return { ...base, outcome: outcome.kind };
}

async function persistOutcome(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  record: OrphanCleanupOutcomeRecord,
): Promise<void> {
  const result = await ctx.fs.writeAtomicExisting(
    outcomePath(daemonDir),
    JSON.stringify(record, null, 2),
  );
  if (result.kind === 'committed_durability_unknown') throw result.error;
}

function readFinalizedOutcome(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  requestId: string,
): OrphanCleanupOutcomeRecord {
  const retired = getOrphanCleanupRetiredDir(daemonDir, requestId);
  const intent: unknown = JSON.parse(ctx.fs.readSync(path.join(retired, INTENT_FILE)));
  const outcome: unknown = JSON.parse(ctx.fs.readSync(path.join(retired, OUTCOME_FILE)));
  if (!isIntent(intent) || intent.request_id !== requestId
      || !isOutcome(outcome) || outcome.request_id !== requestId) {
    throw new Error('retired orphan cleanup identity mismatch');
  }
  return outcome;
}

function finalize(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  requestId: string,
): void {
  const active = getOrphanCleanupActiveDir(daemonDir);
  const retired = getOrphanCleanupRetiredDir(daemonDir, requestId);
  try {
    ctx.fs.moveDirSync(active, retired);
  } catch (error) {
    if (!ctx.fs.existsSync(retired)) throw error;
    const retiredIntent: unknown = JSON.parse(
      ctx.fs.readSync(path.join(retired, INTENT_FILE)),
    );
    if (!isIntent(retiredIntent) || retiredIntent.request_id !== requestId) throw error;
    if (ctx.fs.existsSync(active)) ctx.fs.removeDirSync(active);
  }
}

function blocked(
  stage: OrphanCleanupStage,
  error: unknown,
  pids: number[],
  requestId: string | undefined,
  recovered: boolean,
): OrphanCleanupRun {
  return { kind: 'blocked', stage, error, pids, ...(requestId ? { requestId } : {}), recovered };
}

/** Run or resume the single durable cleanup request for this daemon directory. */
export async function runOrphanCleanup(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  options: SpawnOptions,
  adapters: OrphanCleanupAdapters = {},
): Promise<OrphanCleanupRun> {
  const attempt = beginAttempt(ctx, daemonDir, options);
  if (attempt.kind === 'blocked') {
    return blocked('persist', attempt.error, [], attempt.requestId, attempt.recovered);
  }
  const { intent, recovered } = attempt;

  try {
    const completed = readCompletedOutcome(ctx, daemonDir, intent.request_id);
    if (completed?.outcome === 'clear' || completed?.outcome === 'not_needed') {
      finalize(ctx, daemonDir, intent.request_id);
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_CLEANUP_RECOVERED,
        `daemon_dir=${daemonDir}`,
        `request_id=${intent.request_id}`,
        `outcome=${completed.outcome}`,
      );
      return completed.outcome === 'clear'
        ? { kind: 'clear', terminated: completed.terminated, requestId: intent.request_id, recovered: true }
        : { kind: 'not_needed', requestId: intent.request_id, recovered: true };
    }
  } catch (error) {
    // silent: persisted outcome/finalization failures stay typed and recoverable.
    return blocked('persist', error, [], intent.request_id, recovered);
  }

  const outcome = await terminateMatchingProcesses({
    pattern: options.args.join(' '),
    requiredArgvToken: daemonDir,
    requiredArgvTokens: options.args,
    excludePid: process.pid,
    graceMs: DAEMON_SHUTDOWN_GRACE_MS,
    list: adapters.list ?? (() => findProcessesDetailedAsync(ctx, options.args.join(' '))),
    signal: ctx.kill,
  });
  if (outcome.kind !== 'blocked') {
    for (const pid of outcome.skipped) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_MATCH_SKIPPED,
        `daemon_dir=${daemonDir}`,
        `request_id=${intent.request_id}`,
        `pid=${pid}`,
        `reason=argv_token_mismatch`,
      );
    }
  } else if (outcome.stage === 'signal') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
      `daemon_dir=${daemonDir}`,
      `request_id=${intent.request_id}`,
      `pids=${outcome.pids.join(',')}`,
      `reason=${formatErr(outcome.error)}`,
    );
  }

  try {
    await persistOutcome(ctx, daemonDir, outcomeRecord(intent.request_id, outcome));
  } catch (error) {
    // silent: first reconcile a concurrent winner's retired fact; otherwise the
    // original failed outcome write remains a typed recovery blocker.
    if (isFileNotFound(error)) {
      try {
        const completed = readFinalizedOutcome(ctx, daemonDir, intent.request_id);
        if (completed.outcome === 'clear' || completed.outcome === 'not_needed') {
          ctx.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_CLEANUP_RECOVERED,
            `daemon_dir=${daemonDir}`,
            `request_id=${intent.request_id}`,
            `outcome=${completed.outcome}`,
          );
          return completed.outcome === 'clear'
            ? { kind: 'clear', terminated: completed.terminated, requestId: intent.request_id, recovered: true }
            : { kind: 'not_needed', requestId: intent.request_id, recovered: true };
        }
      } catch {
        // silent: preserve the original write failure below; never guess success.
      }
    }
    return blocked('persist', error, outcome.kind === 'not_needed' ? [] : outcome.pids, intent.request_id, recovered);
  }
  if (outcome.kind === 'blocked') {
    return blocked(outcome.stage, outcome.error, outcome.pids, intent.request_id, recovered);
  }

  try {
    finalize(ctx, daemonDir, intent.request_id);
  } catch (error) {
    // silent: failed finalization leaves the active record for the next attempt.
    return blocked(
      'persist',
      error,
      outcome.kind === 'not_needed' ? [] : outcome.pids,
      intent.request_id,
      recovered,
    );
  }
  if (recovered) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_CLEANUP_RECOVERED,
      `daemon_dir=${daemonDir}`,
      `request_id=${intent.request_id}`,
      `outcome=${outcome.kind}`,
    );
  }
  return outcome.kind === 'clear'
    ? { kind: 'clear', terminated: outcome.terminated, requestId: intent.request_id, recovered }
    : { kind: 'not_needed', requestId: intent.request_id, recovered };
}
