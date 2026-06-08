import { formatErr, assertNever } from './utils/index.js';

export type WriteForbiddenReason = 'system_readonly' | 'outside_allowlist';

export type ErrorCode =
  // Permission errors (1xx)
  | 'PERMISSION_DENIED'
  | 'PATH_NOT_IN_CLAW_SPACE'
  | 'WRITE_OPERATION_FORBIDDEN'

  // Tool errors (2xx)
  | 'TOOL_NOT_FOUND'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_INVALID_INPUT'
  | 'TOOL_TIMEOUT'

  // LLM errors (3xx)
  | 'LLM_CALL_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_AUTH_FAILED'
  | 'LLM_NETWORK_FAILED'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_EMPTY_RESPONSE'
  | 'LLM_ALL_PROVIDERS_FAILED'

  // File system errors (5xx)
  | 'FS_NOT_FOUND'

  // General errors (9xx)
  | 'MAX_STEPS_EXCEEDED'
  | 'CONSECUTIVE_PARSE_ERRORS_EXCEEDED'
  | 'CONSECUTIVE_MAX_TOKENS_TOOL_USE_EXCEEDED'
  | 'WALL_TIME_EXCEEDED'
  | 'UNKNOWN_ERROR';

export interface ErrorDetails {
  code: ErrorCode;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}

// ============================================================================
// Base Error Class
// ============================================================================

export abstract class ClawError extends Error {
  abstract readonly code: ErrorCode;
  readonly context?: Record<string, unknown>;
  readonly timestamp: string;

  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    this.timestamp = new Date().toISOString();

    if (cause) {
      this.cause = cause;
    }
  }

  toJSON(): ErrorDetails {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      ...(this.cause !== undefined && { cause: formatErr(this.cause) }),
    };
  }
}

// ============================================================================
// Permission Errors
// ============================================================================

export class PermissionError extends ClawError {
  readonly code: ErrorCode = 'PERMISSION_DENIED';
}

export class PathNotInClawSpaceError extends PermissionError {
  readonly code: ErrorCode = 'PATH_NOT_IN_CLAW_SPACE';

  constructor(path: string, clawDir: string) {
    super(
      `Path "${path}" is not within claw root`,
      { path, clawDir }
    );
  }
}

// Mirror of src/core/permissions/claw-permissions.ts BASE_WRITABLE_PATHS
// (foundation/ must not import core/; keep in sync manually)
const WRITABLE_ALLOWLIST_HINT =
  'MEMORY.md, memory/, USER.md, IDENTITY.md, SOUL.md, clawspace/, ' +
  'prompts/, skills/, inbox/, outbox/, tasks/, logs/';

function formatWriteForbiddenMessage(
  targetPath: string,
  reason: WriteForbiddenReason,
): string {
  switch (reason) {
    case 'system_readonly':
      return `Path "${targetPath}" cannot be written: target is a claw system path (read-only)`;
    case 'outside_allowlist':
      return `Path "${targetPath}" cannot be written: target is not in claw writable allowlist (${WRITABLE_ALLOWLIST_HINT})`;
    default:
      return assertNever(reason);
  }
}

export class WriteOperationForbiddenError extends PermissionError {
  readonly code: ErrorCode = 'WRITE_OPERATION_FORBIDDEN';

  constructor(targetPath: string, reason: WriteForbiddenReason) {
    super(
      formatWriteForbiddenMessage(targetPath, reason),
      { targetPath, reason }
    );
  }
}

// ============================================================================
// Tool Errors
// ============================================================================

export class ToolError extends ClawError {
  readonly code: ErrorCode = 'TOOL_EXECUTION_FAILED';
}

export class ToolTimeoutError extends ToolError {
  readonly code: ErrorCode = 'TOOL_TIMEOUT';

  constructor(toolName: string, timeoutMs: number) {
    super(
      `Tool "${toolName}" timed out after ${timeoutMs}ms`,
      { toolName, timeoutMs }
    );
  }
}

// ============================================================================
// Programming bug detection
// ============================================================================

const PROGRAMMING_BUG_TYPES = [TypeError, ReferenceError, SyntaxError, RangeError] as const;

export function isProgrammingBug(err: unknown): boolean {
  return PROGRAMMING_BUG_TYPES.some(T => err instanceof T);
}

// ============================================================================
// CLI Error — shared by CLI and Daemon (moved from cli/errors.ts in phase1101)
// ============================================================================

export class CliError extends Error {
  code: number;

  constructor(message: string, code?: number);
  constructor(message: string, options?: { cause?: unknown; code?: number });
  constructor(
    message: string,
    optionsOrCode?: number | { cause?: unknown; code?: number },
  ) {
    if (typeof optionsOrCode === 'number' || optionsOrCode === undefined) {
      super(message);
      this.code = optionsOrCode ?? 1;
    } else {
      super(message, optionsOrCode);
      this.code = optionsOrCode.code ?? 1;
    }
    this.name = 'CliError';
  }
}
