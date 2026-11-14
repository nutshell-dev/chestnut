/**
 * ProcessExec errors (L1)
 *
 * Error types raised by external process execution.
 */

import type { ExecutionTerminationFact } from './types.js';

/**
 * Error thrown when process execution fails.
 * Carries raw output for consumer diagnostics.
 */
export class ProcessExecError extends Error {
  readonly output: string;
  readonly exitCode: number | null;
  readonly code?: string;
  readonly signal?: string;
  readonly killed: boolean;
  readonly maxBufferExceeded: boolean;
  readonly stderr?: string;
  /**
   * Structured termination facts when this error resulted from the L1
   * termination state machine (timeout / maxBuffer / abort / caller
   * requested). Absent for plain spawn errors and natural non-zero exits —
   * those are not termination events.
   */
  readonly termination?: ExecutionTerminationFact;

  constructor(options: {
    message: string;
    output?: string;
    exitCode?: number | null;
    code?: string;
    signal?: string;
    killed?: boolean;
    maxBufferExceeded?: boolean;
    stderr?: string;
    termination?: ExecutionTerminationFact;
  }) {
    super(options.message);
    this.name = 'ProcessExecError';
    this.output = options.output ?? '';
    this.exitCode = options.exitCode ?? null;
    this.code = options.code;
    this.signal = options.signal;
    this.killed = options.killed ?? false;
    this.maxBufferExceeded = options.maxBufferExceeded ?? false;
    this.stderr = options.stderr;
    this.termination = options.termination;
  }
}

/** Thrown when the current host has no supported interpreter for a script file. */
export class UnsupportedHostScriptError extends Error {
  readonly code = 'HOST_SCRIPT_UNSUPPORTED' as const;
  readonly platform: NodeJS.Platform;
  readonly scriptPath: string;
  readonly extension: string;
  readonly allowedExtensions: readonly string[];

  constructor(options: {
    platform: NodeJS.Platform;
    scriptPath: string;
    extension: string;
    allowedExtensions: readonly string[];
  }) {
    const extension = options.extension || '<none>';
    super(
      `Unsupported host script on ${options.platform}: ${options.scriptPath} `
      + `(extension: ${extension}; allowed: ${options.allowedExtensions.join(', ')})`,
    );
    this.name = 'UnsupportedHostScriptError';
    this.platform = options.platform;
    this.scriptPath = options.scriptPath;
    this.extension = options.extension;
    this.allowedExtensions = options.allowedExtensions;
  }
}

/** Process-list operation and stable failure taxonomy for diagnostics/recovery. */
export type ProcessListOperation = 'pgrep' | 'ps';
export type ProcessListFailureClassification =
  | 'spawn_error'
  | 'nonzero_exit'
  | 'signal'
  | 'timeout'
  | 'abort'
  | 'max_buffer';

/** Serializable OS evidence; the original exception remains available as `cause`. */
export interface ProcessListErrorEvidence {
  readonly operation: ProcessListOperation;
  readonly classification: ProcessListFailureClassification;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  /** Original errno-style code (ENOENT, ENOBUFS, ABORT_ERR, ...), when known. */
  readonly code?: string;
}

/**
 * Thrown when pgrep / process listing is unavailable or cannot be trusted.
 * `code` retains its legacy Chestnut error identity; the OS code is in
 * `causeCode` and `evidence.code`.
 */
export class ProcessListUnavailable extends Error {
  readonly code = 'PROCESS_LIST_UNAVAILABLE' as const;
  readonly operation: ProcessListOperation;
  readonly classification: ProcessListFailureClassification;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly causeCode?: string;
  readonly evidence: ProcessListErrorEvidence;

  constructor(
    public readonly pattern: string,
    public readonly cause: unknown,
    evidence: Partial<ProcessListErrorEvidence> = {},
  ) {
    const normalized: ProcessListErrorEvidence = {
      operation: evidence.operation ?? 'pgrep',
      classification: evidence.classification ?? 'spawn_error',
      status: evidence.status ?? null,
      signal: evidence.signal ?? null,
      stderr: evidence.stderr ?? '',
      code: evidence.code,
    };
    // Preserve the legacy message shape; structured diagnostics live in evidence.
    super(`${normalized.operation} unavailable for pattern: ${pattern}`);
    this.name = 'ProcessListUnavailable';
    this.operation = normalized.operation;
    this.classification = normalized.classification;
    this.status = normalized.status;
    this.signal = normalized.signal;
    this.stderr = normalized.stderr;
    this.causeCode = normalized.code;
    this.evidence = normalized;
  }
}
