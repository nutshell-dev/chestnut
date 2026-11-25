/**
 * @module L6.Watchdog.ClawsObservation
 * Typed claws-directory observations and recoverable supervision state.
 *
 * A missing directory is a known-empty supervision scope. Permission, capability
 * and I/O failures instead make coverage unknown; callers must not substitute []
 * for that unknown scope.
 */

import { CLAWS_DIR, type ClawId } from '../foundation/claw-identity/index.js';
import { enumerateOrdinaryClaws } from '../core/claw-topology/index.js';
import { isFileNotFound, type FileSystem } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';

export const CLAWS_SUPERVISION_RETRY_BASE_MS = 30_000;
export const CLAWS_SUPERVISION_RETRY_MAX_MS = 5 * 60_000;

export type ClawsDirectoryFailureReason = 'permission_denied' | 'missing_capability' | 'io_failed';

type RejectedClawDirectory = ReturnType<typeof enumerateOrdinaryClaws>['invalid'][number];

export interface DirectoryEvidence {
  readonly directory: typeof CLAWS_DIR;
  readonly observedAtMs: number;
  readonly outcome: 'available' | 'empty' | 'unavailable';
  readonly rejected?: readonly RejectedClawDirectory[];
  readonly reason?: ClawsDirectoryFailureReason;
  readonly code?: string;
  readonly error?: string;
}

export type ClawsDirectoryObservation =
  | { readonly kind: 'available'; readonly clawIds: ClawId[]; readonly evidence: DirectoryEvidence }
  | { readonly kind: 'empty'; readonly evidence: DirectoryEvidence }
  | {
      readonly kind: 'unavailable';
      readonly reason: ClawsDirectoryFailureReason;
      readonly error: unknown;
      readonly evidence: DirectoryEvidence;
    };

export type SupervisionCoverage =
  | { readonly kind: 'known'; readonly clawIds: ClawId[] }
  | { readonly kind: 'unknown'; readonly reason: 'directory_unavailable'; readonly retryAtMs: number };

export interface ClawsSupervisionState {
  readonly status: 'covered' | 'degraded';
  readonly consecutiveFailures: number;
  readonly lastFailure?: DirectoryEvidence;
  readonly lastRecoveredAtMs?: number;
  readonly nextRetryAtMs: number;
}

export type ClawsSupervisionTransition = 'none' | 'degraded' | 'recovered';

export function coveredClawsSupervisionState(): ClawsSupervisionState {
  return { status: 'covered', consecutiveFailures: 0, nextRetryAtMs: 0 };
}

export function cloneClawsSupervisionState(state: ClawsSupervisionState): ClawsSupervisionState {
  return {
    ...state,
    ...(state.lastFailure ? { lastFailure: { ...state.lastFailure } } : {}),
  };
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function classifyClawsDirectoryFailure(error: unknown): ClawsDirectoryFailureReason {
  const code = getErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (
    code === 'ENOSYS'
    || code === 'ENOTSUP'
    || code === 'EOPNOTSUPP'
    || /missing[-_ ]capability/i.test(formatErr(error))
  ) {
    return 'missing_capability';
  }
  return 'io_failed';
}

export function clawsSupervisionRetryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(0, consecutiveFailures - 1), 30);
  return Math.min(CLAWS_SUPERVISION_RETRY_BASE_MS * 2 ** exponent, CLAWS_SUPERVISION_RETRY_MAX_MS);
}

/** Read and classify the directory without assigning supervision semantics to the FS layer. */
export function observeClawsDirectory(fs: FileSystem, observedAtMs: number): ClawsDirectoryObservation {
  try {
    const { valid: clawIds, invalid: rejected } = enumerateOrdinaryClaws(fs, CLAWS_DIR);
    return clawIds.length > 0 || rejected.length > 0
      ? {
          kind: 'available',
          clawIds,
          evidence: {
            directory: CLAWS_DIR,
            observedAtMs,
            outcome: 'available',
            ...(rejected.length > 0 ? { rejected } : {}),
          },
        }
      : {
          kind: 'empty',
          evidence: { directory: CLAWS_DIR, observedAtMs, outcome: 'empty' },
        };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        kind: 'empty',
        evidence: { directory: CLAWS_DIR, observedAtMs, outcome: 'empty' },
      };
    }
    const reason = classifyClawsDirectoryFailure(error);
    return {
      kind: 'unavailable',
      reason,
      error,
      evidence: {
        directory: CLAWS_DIR,
        observedAtMs,
        outcome: 'unavailable',
        reason,
        ...(getErrorCode(error) ? { code: getErrorCode(error) } : {}),
        error: formatErr(error),
      },
    };
  }
}

export function reduceClawsDirectoryObservation(
  previous: ClawsSupervisionState,
  observation: ClawsDirectoryObservation,
): { readonly state: ClawsSupervisionState; readonly transition: ClawsSupervisionTransition } {
  if (observation.kind === 'unavailable') {
    const consecutiveFailures = previous.consecutiveFailures + 1;
    return {
      transition: 'degraded',
      state: {
        status: 'degraded',
        consecutiveFailures,
        lastFailure: observation.evidence,
        ...(previous.lastRecoveredAtMs !== undefined
          ? { lastRecoveredAtMs: previous.lastRecoveredAtMs }
          : {}),
        nextRetryAtMs: observation.evidence.observedAtMs + clawsSupervisionRetryDelayMs(consecutiveFailures),
      },
    };
  }

  const recovered = previous.status === 'degraded';
  return {
    transition: recovered ? 'recovered' : 'none',
    state: {
      status: 'covered',
      consecutiveFailures: 0,
      ...(previous.lastFailure ? { lastFailure: previous.lastFailure } : {}),
      ...(recovered
        ? { lastRecoveredAtMs: observation.evidence.observedAtMs }
        : previous.lastRecoveredAtMs !== undefined
          ? { lastRecoveredAtMs: previous.lastRecoveredAtMs }
          : {}),
      nextRetryAtMs: 0,
    },
  };
}

function normalizeDirectoryEvidence(value: unknown): DirectoryEvidence | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new Error('watchdog-state.json invalid clawsSupervision.lastFailure');
  }
  const evidence = value as Record<string, unknown>;
  if (
    evidence.directory !== CLAWS_DIR
    || typeof evidence.observedAtMs !== 'number'
    || !Number.isFinite(evidence.observedAtMs)
    || (evidence.outcome !== 'available' && evidence.outcome !== 'empty' && evidence.outcome !== 'unavailable')
    || (evidence.code !== undefined && typeof evidence.code !== 'string')
    || (evidence.error !== undefined && typeof evidence.error !== 'string')
  ) {
    throw new Error('watchdog-state.json invalid clawsSupervision.lastFailure');
  }
  if (
    evidence.reason !== undefined
    && evidence.reason !== 'permission_denied'
    && evidence.reason !== 'missing_capability'
    && evidence.reason !== 'io_failed'
  ) {
    throw new Error('watchdog-state.json invalid clawsSupervision.lastFailure');
  }
  return {
    directory: CLAWS_DIR,
    observedAtMs: evidence.observedAtMs,
    outcome: evidence.outcome,
    ...(evidence.reason !== undefined ? { reason: evidence.reason } : {}),
    ...(typeof evidence.code === 'string' ? { code: evidence.code } : {}),
    ...(typeof evidence.error === 'string' ? { error: evidence.error } : {}),
  };
}

/** Normalize old states (no claws field) and validate persisted degraded evidence. */
export function normalizeClawsSupervisionState(value: unknown): ClawsSupervisionState {
  if (value === undefined) return coveredClawsSupervisionState();
  if (typeof value !== 'object' || value === null) {
    throw new Error('watchdog-state.json invalid clawsSupervision');
  }
  const state = value as Record<string, unknown>;
  const lastFailure = normalizeDirectoryEvidence(state.lastFailure);
  const lastRecoveredAtMs = state.lastRecoveredAtMs;
  if (
    lastRecoveredAtMs !== undefined
    && (typeof lastRecoveredAtMs !== 'number' || !Number.isFinite(lastRecoveredAtMs))
  ) {
    throw new Error('watchdog-state.json invalid clawsSupervision.lastRecoveredAtMs');
  }
  if (
    state.status === 'covered'
    && state.consecutiveFailures === 0
    && state.nextRetryAtMs === 0
  ) {
    return {
      status: 'covered',
      consecutiveFailures: 0,
      ...(lastFailure ? { lastFailure } : {}),
      ...(typeof lastRecoveredAtMs === 'number' ? { lastRecoveredAtMs } : {}),
      nextRetryAtMs: 0,
    };
  }
  if (
    state.status === 'degraded'
    && Number.isInteger(state.consecutiveFailures)
    && (state.consecutiveFailures as number) > 0
    && typeof state.nextRetryAtMs === 'number'
    && Number.isFinite(state.nextRetryAtMs)
    && state.nextRetryAtMs > 0
    && lastFailure?.outcome === 'unavailable'
  ) {
    return {
      status: 'degraded',
      consecutiveFailures: state.consecutiveFailures as number,
      lastFailure,
      ...(typeof lastRecoveredAtMs === 'number' ? { lastRecoveredAtMs } : {}),
      nextRetryAtMs: state.nextRetryAtMs,
    };
  }
  throw new Error('watchdog-state.json invalid clawsSupervision');
}
