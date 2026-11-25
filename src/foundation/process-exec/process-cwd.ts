/**
 * @module L1.ProcessExec.ProcessCwd
 * Bounded, neutral observation of a process's current working directory.
 */
import { exec } from './exec.js';
import { ProcessExecError } from './errors.js';
import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';
import type { ExecResult, ProcessUnavailableReason } from './types.js';

const CWD_QUERY_TIMEOUT_MS = 2000;
const CWD_QUERY_MAX_BUFFER = 64 * 1024;

export type ProcessCwdObservation =
  | { kind: 'observed'; cwd: string; evidence: ProcessEvidence }
  | { kind: 'unknown'; reason: ProcessUnavailableReason; evidence: ProcessEvidence };

function parseCwd(stdout: string, pid: number): string | undefined {
  const records = stdout.split('\0').map(field => field.replace(/^\n/, '')).filter(Boolean);
  if (records.length !== 3 || records[0] !== `p${pid}` || records[1] !== 'fcwd') {
    return undefined;
  }
  const name = records[2]!;
  return name.startsWith('n/') ? name.slice(1) : undefined;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

function errorName(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'name' in error
    ? (error as { name: unknown }).name
    : undefined;
}

function unavailableReason(error: unknown): ProcessUnavailableReason {
  const code = errorCode(error);
  if (code === 'EPERM' || code === 'EACCES') return 'permission_denied';
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR'
      || errorName(error) === 'TimeoutError' || errorName(error) === 'AbortError'
      || (error instanceof ProcessExecError && error.termination?.trigger === 'timeout')) {
    return 'timed_out';
  }
  return 'query_failed';
}

/** Observe one PID's current cwd on macOS without a shell or a gone inference. */
export async function observeProcessCwd(
  pid: number,
  execute: typeof exec = exec,
): Promise<ProcessCwdObservation> {
  const atMs = Date.now();
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return {
      kind: 'unknown', reason: 'incomplete_data',
      evidence: encodeProcessEvidence(atMs, [{ operation: 'cwd', outcome: 'invalid_pid', pid }]),
    };
  }
  if (process.platform !== 'darwin') {
    return {
      kind: 'unknown', reason: 'unsupported',
      evidence: encodeProcessEvidence(atMs, [{
        operation: 'cwd', outcome: 'unsupported_platform', pid, platform: process.platform,
      }]),
    };
  }

  let raw: ExecResult;
  try {
    raw = await execute('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F0pfn'], {
      cwd: '/',
      timeout: CWD_QUERY_TIMEOUT_MS,
      maxBuffer: CWD_QUERY_MAX_BUFFER,
    });
  } catch (error) {
    return {
      kind: 'unknown', reason: unavailableReason(error),
      evidence: encodeProcessEvidence(atMs, [{ operation: 'cwd', outcome: 'throw', pid, error }]),
    };
  }

  const cwd = parseCwd(raw.stdout, pid);
  const evidence = encodeProcessEvidence(atMs, [{
    operation: 'cwd', outcome: cwd === undefined ? 'unavailable' : 'observed', pid, raw,
    ...(cwd === undefined ? {} : { cwd }),
  }]);
  return cwd === undefined
    ? { kind: 'unknown', reason: 'query_failed', evidence }
    : { kind: 'observed', cwd, evidence };
}
