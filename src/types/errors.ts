/**
 * Error types - Custom error classes
 * Phase 0: Interface definitions only
 */

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
  | 'LLM_ALL_PROVIDERS_FAILED'
  
  // Contract errors (4xx)
  | 'CONTRACT_NOT_FOUND'
  | 'CONTRACT_INVALID_STATE'
  
  // File system errors (5xx)
  | 'FS_READ_ERROR'
  | 'FS_WRITE_ERROR'
  | 'FS_NOT_FOUND'
  
  // General errors (9xx)
  | 'MAX_STEPS_EXCEEDED'
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
// LLM Errors
// ============================================================================

export class LLMError extends ClawError {
  readonly code: ErrorCode = 'LLM_CALL_FAILED';
}

export class LLMRateLimitError extends LLMError {
  readonly code: ErrorCode = 'LLM_RATE_LIMITED';
  readonly retryAfter?: number;
  
  constructor(provider: string, retryAfter?: number) {
    super(
      `Rate limited by provider "${provider}"`,
      { provider, retryAfter }
    );
    this.retryAfter = retryAfter;
  }
}

export class LLMTimeoutError extends LLMError {
  readonly code: ErrorCode = 'LLM_TIMEOUT';
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(
      `LLM call to "${provider}" timed out after ${timeoutMs}ms`,
      { provider, timeoutMs }
    );
    this.timeoutMs = timeoutMs;
  }
}

export class LLMAllProvidersFailedError extends LLMError {
  readonly code: ErrorCode = 'LLM_ALL_PROVIDERS_FAILED';
  readonly failures: Array<{ provider: string; error: Error }>;
  
  constructor(failures: Array<{ provider: string; error: Error }>) {
    const summary = failures
      .map(f => `${f.provider} (${f.error.message.slice(0, 80)})`)
      .join(', ');
    super(
      `All LLM providers failed: ${summary}`,
      { failures: failures.map(f => ({ provider: f.provider, error: f.error.message })) }
    );
    this.failures = failures;
  }
}

// ============================================================================
// Contract Errors
// ============================================================================

export class ContractError extends ClawError {
  readonly code: ErrorCode = 'CONTRACT_INVALID_STATE';
}

export class ContractNotFoundError extends ContractError {
  readonly code: ErrorCode = 'CONTRACT_NOT_FOUND';
  
  constructor(contractId: string) {
    super(`Contract "${contractId}" not found`, { contractId });
  }
}

// ============================================================================
// File System Errors
// ============================================================================

export class FileSystemError extends ClawError {
  readonly code: ErrorCode = 'FS_READ_ERROR';
}

export class FileNotFoundError extends FileSystemError {
  readonly code: ErrorCode = 'FS_NOT_FOUND';
  
  constructor(path: string) {
    super(`File not found: "${path}"`, { path });
  }
}

// ============================================================================
// Runtime Errors
// ============================================================================

export class MaxStepsExceededError extends ClawError {
  readonly code: ErrorCode = 'MAX_STEPS_EXCEEDED';
  
  constructor(maxSteps: number) {
    super(
      `Maximum steps (${maxSteps}) exceeded`,
      { maxSteps }
    );
  }
}
