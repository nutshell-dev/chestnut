import { formatErr } from './utils/format.js';

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
      `Path "${path}" is not within the claw's workspace`,
      { path, clawDir }
    );
  }
}

export class WriteOperationForbiddenError extends PermissionError {
  readonly code: ErrorCode = 'WRITE_OPERATION_FORBIDDEN';

  constructor(toolName: string, profile: string) {
    super(
      `Tool "${toolName}" is not allowed in "${profile}" profile`,
      { toolName, profile }
    );
  }
}

// ============================================================================
// Tool Errors
// ============================================================================

export class ToolError extends ClawError {
  readonly code: ErrorCode = 'TOOL_EXECUTION_FAILED';
}

export class ToolNotFoundError extends ToolError {
  readonly code: ErrorCode = 'TOOL_NOT_FOUND';

  constructor(toolName: string) {
    super(`Tool "${toolName}" not found`, { toolName });
  }
}

export class ToolInvalidInputError extends ToolError {
  readonly code: ErrorCode = 'TOOL_INVALID_INPUT';

  constructor(toolName: string, validationError: string) {
    super(
      `Invalid input for tool "${toolName}": ${validationError}`,
      { toolName, validationError }
    );
  }
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
