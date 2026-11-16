/**
 * @module L1.ProcessExec
 *
 * Capability-driven process-list backend selection. Registry details stay
 * inside ProcessExec; consumers receive only ProcessInfo[] or typed failure.
 */

import {
  ProcessListUnavailable,
  type ProcessListEvidence,
  type ProcessListOperation,
} from './errors.js';
import type { ProcessInfo } from './types.js';

export interface ProcessListOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
}

export type BackendProbe =
  | { kind: 'available'; backendId: string; evidence: ProcessListEvidence[] }
  | { kind: 'unavailable'; backendId: string; evidence: ProcessListEvidence[]; error?: unknown };

export interface ProcessListBackend {
  readonly id: string;
  readonly probe: (options?: ProcessListOptions) => Promise<BackendProbe>;
  readonly findByPattern: (
    pattern: string,
    options: ProcessListOptions,
  ) => Promise<ProcessInfo[]>;
  /** Explicit CLI-only synchronous adapter; async queries never call it. */
  readonly probeSyncForCli?: () => BackendProbe;
  readonly findByPatternSyncForCli?: (pattern: string) => ProcessInfo[];
}

export interface ProcessListBackendSelection {
  readonly backend: ProcessListBackend;
  readonly evidence: ProcessListEvidence[];
}

function errnoCode(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    && typeof (cause as NodeJS.ErrnoException).code === 'string'
    ? (cause as NodeJS.ErrnoException).code
    : undefined;
}

function withPattern(
  pattern: string,
  backendId: string,
  operation: ProcessListOperation,
  cause: unknown,
): ProcessListUnavailable {
  if (cause instanceof ProcessListUnavailable) {
    return new ProcessListUnavailable(pattern, cause.cause, cause.evidence, {
      evidenceChain: cause.evidenceChain,
    });
  }
  return new ProcessListUnavailable(pattern, cause, {
    backendId,
    operation,
    classification: 'spawn_error',
    code: errnoCode(cause),
  });
}

function unsupported(pattern: string): ProcessListUnavailable {
  return new ProcessListUnavailable(pattern, new Error('No process-list backend registered'), {
    backendId: 'unsupported',
    operation: 'backend',
    classification: 'unsupported',
  });
}

function serializeEvidence(evidence: readonly ProcessListEvidence[]): string {
  return JSON.stringify(evidence);
}

function allBackendsUnavailable(
  pattern: string,
  evidence: ProcessListEvidence[],
  causes: unknown[],
): ProcessListUnavailable {
  if (causes.length === 1 && causes[0] instanceof ProcessListUnavailable) {
    const error = causes[0];
    return new ProcessListUnavailable(pattern, error.cause, error.evidence, { evidenceChain: evidence });
  }
  const cause = new AggregateError(causes, 'No process-list backend available');
  return new ProcessListUnavailable(pattern, cause, {
    backendId: 'registry',
    operation: 'backend',
    classification: 'unsupported',
    stderr: serializeEvidence(evidence),
  }, { evidenceChain: evidence });
}

function thrownProbe(pattern: string, backend: ProcessListBackend, cause: unknown): BackendProbe {
  const error = withPattern(pattern, backend.id, 'probe', cause);
  return { kind: 'unavailable', backendId: backend.id, evidence: error.evidenceChain.slice(), error };
}

async function probeAsync(
  backend: ProcessListBackend,
  pattern: string,
  options: ProcessListOptions,
): Promise<BackendProbe> {
  try {
    return await backend.probe(options);
  } catch (cause) {
    // silent: the thrown fact is converted into BackendProbe evidence for fallback.
    return thrownProbe(pattern, backend, cause);
  }
}

function probeSync(backend: ProcessListBackend, pattern: string): BackendProbe {
  if (!backend.probeSyncForCli || !backend.findByPatternSyncForCli) {
    const cause = new Error(`Backend ${backend.id} has no synchronous CLI adapter`);
    return thrownProbe(pattern, backend, cause);
  }
  try {
    return backend.probeSyncForCli();
  } catch (cause) {
    // silent: the thrown fact is converted into BackendProbe evidence for fallback.
    return thrownProbe(pattern, backend, cause);
  }
}

/** Select the first actually available backend, preserving every rejected probe. */
export async function selectProcessListBackend(
  backends: readonly ProcessListBackend[],
  pattern = '',
  options: ProcessListOptions = {},
): Promise<ProcessListBackendSelection> {
  if (backends.length === 0) throw unsupported(pattern);
  const evidence: ProcessListEvidence[] = [];
  const causes: unknown[] = [];
  for (const backend of backends) {
    const probe = await probeAsync(backend, pattern, options);
    evidence.push(...probe.evidence);
    if (probe.kind === 'available') return { backend, evidence };
    causes.push(probe.error ?? new Error(`Backend ${backend.id} unavailable`));
  }
  throw allBackendsUnavailable(pattern, evidence, causes);
}

/** Synchronous CLI selection uses only the explicit sync adapter. */
export function selectProcessListBackendSyncForCli(
  backends: readonly ProcessListBackend[],
  pattern = '',
): ProcessListBackendSelection {
  if (backends.length === 0) throw unsupported(pattern);
  const evidence: ProcessListEvidence[] = [];
  const causes: unknown[] = [];
  for (const backend of backends) {
    const probe = probeSync(backend, pattern);
    evidence.push(...probe.evidence);
    if (probe.kind === 'available') return { backend, evidence };
    causes.push(probe.error ?? new Error(`Backend ${backend.id} unavailable`));
  }
  throw allBackendsUnavailable(pattern, evidence, causes);
}

/** Query with probe and query failure fallback; [] is exclusively a successful no-match. */
export async function findByPatternWithBackends(
  pattern: string,
  options: ProcessListOptions,
  backends: readonly ProcessListBackend[],
): Promise<ProcessInfo[]> {
  if (backends.length === 0) throw unsupported(pattern);
  const evidence: ProcessListEvidence[] = [];
  const causes: unknown[] = [];
  for (const backend of backends) {
    const probe = await probeAsync(backend, pattern, options);
    evidence.push(...probe.evidence);
    if (probe.kind === 'unavailable') {
      causes.push(probe.error ?? new Error(`Backend ${backend.id} unavailable`));
      continue;
    }
    try {
      return await backend.findByPattern(pattern, options);
    } catch (cause) {
      // silent: query failure is appended to evidence before fallback or typed throw.
      const error = withPattern(pattern, backend.id, 'backend', cause);
      evidence.push(...error.evidenceChain);
      causes.push(error);
    }
  }
  throw allBackendsUnavailable(pattern, evidence, causes);
}

/** CLI parity path; production async code has no spawnSync dependency here. */
export function findByPatternWithBackendsSyncForCli(
  pattern: string,
  backends: readonly ProcessListBackend[],
): ProcessInfo[] {
  if (backends.length === 0) throw unsupported(pattern);
  const evidence: ProcessListEvidence[] = [];
  const causes: unknown[] = [];
  for (const backend of backends) {
    const probe = probeSync(backend, pattern);
    evidence.push(...probe.evidence);
    if (probe.kind === 'unavailable') {
      causes.push(probe.error ?? new Error(`Backend ${backend.id} unavailable`));
      continue;
    }
    try {
      return backend.findByPatternSyncForCli!(pattern);
    } catch (cause) {
      // silent: query failure is appended to evidence before fallback or typed throw.
      const error = withPattern(pattern, backend.id, 'backend', cause);
      evidence.push(...error.evidenceChain);
      causes.push(error);
    }
  }
  throw allBackendsUnavailable(pattern, evidence, causes);
}
