import { isFileNotFound, type FileSystem } from '../fs/index.js';
import {
  captureCurrentProcessRef,
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRefCapture,
  type ProcessRefDecode,
} from '../process-exec/index.js';
import { SkillVersionError } from './version-types.js';
import {
  StateLockObservationWriter,
  type LeaseFact,
  type LockDecision,
  type ProcessFacts,
} from './state-lock-evidence.js';

const STATE_LOCK_FILE = 'state.lock';
const STATE_LOCK_ATTEMPTS = 100;
const STATE_LOCK_DELAY_MS = 10;
const STATE_LOCK_STALE_MS = 30_000;

type LockV2 = {
  lock_version: 2;
  at: number;
  observationAttemptId: string;
  holder: { kind: 'reference'; ref: string } | { kind: 'unknown' };
};

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isV2(value: Record<string, unknown>): value is LockV2 & Record<string, unknown> {
  const holder = value.holder;
  return value.lock_version === 2 && typeof value.at === 'number'
    && typeof value.observationAttemptId === 'string' && value.observationAttemptId.length > 0
    && isRecord(holder) && (
      (holder.kind === 'unknown')
      || (holder.kind === 'reference' && typeof holder.ref === 'string' && holder.ref.length > 0)
    );
}

function leaseFact(source: 'at' | 'mtime', valueMs: number): LeaseFact {
  return {
    source,
    valueMs,
    observedAtMs: Date.now(),
    limitMs: STATE_LOCK_STALE_MS,
    ...(!Number.isFinite(valueMs) && { valueMsText: String(valueMs) }),
  };
}

function isLeaseElapsed(lease: LeaseFact): boolean {
  return lease.observedAtMs - lease.valueMs > STATE_LOCK_STALE_MS;
}

function processError(
  error: unknown,
  lockRaw: string,
  processFacts: ProcessFacts,
  observations: StateLockObservationWriter,
): SkillVersionError {
  return new SkillVersionError(
    'store_error',
    `State lock process observation failed; evidence location ${observations.location}`,
    {
      cause: {
        kind: 'state_lock_process_observation_failed',
        operation: 'process_observation',
        lockRaw,
        processFacts,
        error,
      },
      evidence: [observations.location],
    },
  );
}

/**
 * Observe one existing lock and durably record the decision before acting on it.
 * Returns true only when the caller should retry O_EXCL (including after reclaim).
 */
async function observeExistingLock(
  stateFs: FileSystem,
  observations: StateLockObservationWriter,
): Promise<boolean> {
  let lockRaw: string;
  try {
    lockRaw = await stateFs.read(STATE_LOCK_FILE);
  } catch (error) {
    if (isFileNotFound(error)) {
      observations.recordDecision({
        lockRaw: '',
        process: {},
        decision: { kind: 'retry', reason: 'absent' },
      });
      return true;
    }
    throw new SkillVersionError(
      'store_error',
      `State lock read failed; evidence location ${observations.location}`,
      { cause: { operation: 'read', lockRaw: undefined, error } },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lockRaw) as unknown;
  } catch {
    // silent: malformed lock content is handled by conservative mtime lease rules below.
    parsed = undefined;
  }

  if (isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'lock_version')
      && parsed.lock_version !== 2) {
    observations.recordDecision({
      lockRaw,
      process: {},
      decision: { kind: 'wait', reason: 'unsupported_version' },
    });
    return false;
  }

  const processFacts: ProcessFacts = {};
  let target: unknown;
  let hasTarget = false;
  let at: unknown;

  if (isRecord(parsed) && parsed.lock_version === 2) {
    if (isV2(parsed)) {
      at = parsed.at;
      if (parsed.holder.kind === 'reference') {
        target = parsed.holder.ref;
        hasTarget = true;
      }
    } else if (typeof parsed.at === 'number') {
      // A malformed known-v2 envelope remains eligible only for independent lease
      // takeover; it never falls back to legacy pid fields.
      at = parsed.at;
    }
  } else if (isRecord(parsed)) {
    at = parsed.at;
    if (typeof parsed.pid === 'number') {
      target = { version: 0, pid: parsed.pid, startTime: undefined };
      hasTarget = true;
    }
  }

  if (hasTarget) {
    let decoded: ProcessRefDecode;
    try {
      decoded = decodeProcessRef(target);
      processFacts.decoded = decoded;
      if (decoded.kind === 'decoded') {
        processFacts.observed = inspectProcessRef(decoded.value);
      }
    } catch (error) {
      throw processError(error, lockRaw, processFacts, observations);
    }
  }

  if (processFacts.observed?.kind === 'gone') {
    observations.recordDecision({
      lockRaw,
      process: processFacts,
      decision: { kind: 'takeover', reason: 'process_gone' },
    });
    await stateFs.delete(STATE_LOCK_FILE).catch(() => {
      // silent: legacy takeover delete failure is retried by re-observation.
    });
    return true;
  }

  let lease: LeaseFact;
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) {
    lease = leaseFact('at', at);
  } else {
    try {
      const stat = await stateFs.stat(STATE_LOCK_FILE);
      lease = leaseFact('mtime', stat.mtime.getTime());
    } catch (error) {
      if (isFileNotFound(error)) {
        observations.recordDecision({
          lockRaw,
          process: processFacts,
          decision: { kind: 'retry', reason: 'absent' },
        });
        return true;
      }
      observations.recordBeforeIoFailure({
        lockRaw,
        process: processFacts,
        operation: 'stat',
        decision: 'stop',
      }, error);
      throw new SkillVersionError(
        'store_error',
        `State lock stat failed; prior facts preserved at ${observations.lastRecordPath ?? observations.location}`,
        {
          cause: {
            operation: 'stat',
            lockRaw,
            processFacts,
            recordPath: observations.lastRecordPath,
            error,
          },
          evidence: [observations.location],
        },
      );
    }
  }

  const decision: LockDecision = isLeaseElapsed(lease)
    ? { kind: 'takeover', reason: 'lease_elapsed' }
    : {
        kind: 'wait',
        reason: processFacts.observed?.kind === 'alive' ? 'held' : 'unknown',
      };
  observations.recordDecision({ lockRaw, process: processFacts, lease, decision });
  if (decision.kind === 'takeover') {
    await stateFs.delete(STATE_LOCK_FILE).catch(() => {
      // silent: preserve legacy takeover/retry error priority and generation risk.
    });
    return true;
  }
  return false;
}

/**
 * state.json critical section. Self capture is persisted before publishing a v2
 * reference; legacy locks remain readable through the L1 v0 adapter.
 * 100 attempts with 10ms waits are a retry policy, not a 1s wall-clock bound:
 * synchronous L1 OS queries and evidence I/O have their own existing costs.
 */
export async function withSkillStateLock<T>(
  stateFs: FileSystem,
  fn: () => Promise<T>,
): Promise<T> {
  const observations = new StateLockObservationWriter(stateFs);
  let captured: ProcessRefCapture;
  try {
    captured = captureCurrentProcessRef();
  } catch (error) {
    throw new SkillVersionError(
      'store_error',
      `State lock self capture failed; evidence location ${observations.location}`,
      { cause: { operation: 'capture', error }, evidence: [observations.location] },
    );
  }
  observations.recordCapture(captured);
  for (let attempt = 0; ; attempt++) {
    try {
      await stateFs.writeExclusive(
        STATE_LOCK_FILE,
        JSON.stringify({
          lock_version: 2,
          at: Date.now(),
          observationAttemptId: observations.attemptId,
          holder: captured.kind === 'captured'
            ? { kind: 'reference', ref: captured.value }
            : { kind: 'unknown' },
        } satisfies LockV2),
      );
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (attempt + 1 >= STATE_LOCK_ATTEMPTS) {
        throw new SkillVersionError(
          'store_error',
          `version service state lock contention exhausted: ${STATE_LOCK_FILE}; observations at ${observations.location}`,
          { evidence: [observations.location] },
        );
      }
      if (await observeExistingLock(stateFs, observations)) continue;
      await new Promise<void>(resolve => { setTimeout(resolve, STATE_LOCK_DELAY_MS); });
    }
  }
  try {
    return await fn();
  } finally {
    await stateFs.delete(STATE_LOCK_FILE).catch(() => {
      // silent: release failure does not hide the critical section result/error.
    });
  }
}
