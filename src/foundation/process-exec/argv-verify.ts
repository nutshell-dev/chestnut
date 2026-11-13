/**
 * @module L1.ProcessExec.ArgvVerify
 * Typed argv identity observation and the legacy boolean compatibility wrapper.
 * PID-reuse defenses must not flatten query/permission failures into a mismatch.
 */

import { spawnSync } from 'child_process';
import { PROCESS_EXEC_DEFAULT_MAX_BUFFER } from './constants.js';
import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';
import type { ProcessUnavailableReason } from './process-reference.js';

const ARGV_QUERY_TIMEOUT_MS = 1000;

export type ProcessArgvObservation =
  | { kind: 'match'; evidence: ProcessEvidence }
  | { kind: 'mismatch'; evidence: ProcessEvidence }
  | { kind: 'gone'; evidence: ProcessEvidence }
  | {
      kind: 'unknown';
      reason: ProcessUnavailableReason;
      evidence: ProcessEvidence;
      error?: unknown;
    };

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

function unavailableReason(error: unknown): ProcessUnavailableReason {
  const code = errorCode(error);
  if (code === 'EPERM' || code === 'EACCES') return 'permission_denied';
  if (code === 'ETIMEDOUT') return 'timed_out';
  return 'query_failed';
}

/** Observe argv without exposing host command output or flattening OS errors. */
export function observePidArgv(pid: number, expectedToken: string): ProcessArgvObservation {
  const atMs = Date.now();
  if (!expectedToken) {
    return {
      kind: 'unknown', reason: 'incomplete_data',
      evidence: encodeProcessEvidence(atMs, [{
        operation: 'argv', outcome: 'invalid_token', pid, expectedToken,
      }]),
    };
  }

  let raw: ReturnType<typeof spawnSync>;
  try {
    raw = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: ARGV_QUERY_TIMEOUT_MS,
      maxBuffer: PROCESS_EXEC_DEFAULT_MAX_BUFFER,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    return {
      kind: 'unknown', reason: unavailableReason(error), error,
      evidence: encodeProcessEvidence(atMs, [{ operation: 'argv', outcome: 'throw', pid, error }]),
    };
  }

  const evidence = encodeProcessEvidence(atMs, [{ operation: 'argv', outcome: 'result', pid, raw }]);
  if (raw.error || raw.status === null || raw.signal !== null) {
    const error = raw.error ?? new Error(`argv query failed for pid ${pid}`);
    return { kind: 'unknown', reason: unavailableReason(error), error, evidence };
  }
  // ps(1) uses status 1 when the selected process no longer exists.
  if (raw.status === 1) return { kind: 'gone', evidence };
  if (raw.status !== 0 || typeof raw.stdout !== 'string' || raw.stdout.trim().length === 0) {
    const error = new Error(`argv evidence unavailable for pid ${pid} (status=${raw.status})`);
    return { kind: 'unknown', reason: 'query_failed', error, evidence };
  }
  return raw.stdout.includes(expectedToken)
    ? { kind: 'match', evidence }
    : { kind: 'mismatch', evidence };
}

/** Legacy boolean API. New callers should consume observeProcessTarget instead. */
export function isPidArgvMatching(pid: number, expectedToken: string): boolean {
  return observePidArgv(pid, expectedToken).kind === 'match';
}
