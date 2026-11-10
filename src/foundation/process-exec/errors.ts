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

/**
 * Thrown when pgrep / process listing binary is unavailable.
 */
export class ProcessListUnavailable extends Error {
  readonly code = 'PROCESS_LIST_UNAVAILABLE' as const;
  constructor(public readonly pattern: string, public readonly cause: unknown) {
    super(`pgrep unavailable for pattern: ${pattern}`);
    this.name = 'ProcessListUnavailable';
  }
}
