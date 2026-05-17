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
  | 'LLM_AUTH_FAILED'
  | 'LLM_NETWORK_FAILED'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_ALL_PROVIDERS_FAILED'
  
  // File system errors (5xx)
  | 'FS_NOT_FOUND'
  
  // General errors (9xx)
  | 'MAX_STEPS_EXCEEDED'
  | 'CONSECUTIVE_PARSE_ERRORS_EXCEEDED'
  | 'CONSECUTIVE_MAX_TOKENS_TOOL_USE_EXCEEDED'
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

export class LLMAuthError extends LLMError {
  readonly code: ErrorCode = 'LLM_AUTH_FAILED';
  constructor(provider: string, statusCode: number, message?: string) {
    super(
      message ?? `LLM auth failed for ${provider} (HTTP ${statusCode})`,
      { provider, statusCode },
    );
  }
}

export class LLMNetworkError extends LLMError {
  readonly code: ErrorCode = 'LLM_NETWORK_FAILED';
  constructor(provider: string, cause?: Error) {
    super(
      `LLM network failure for ${provider}${cause ? `: ${cause.message}` : ''}`,
      { provider },
      cause,
    );
  }
}

export class LLMModelNotFoundError extends LLMError {
  readonly code: ErrorCode = 'LLM_MODEL_NOT_FOUND';
  constructor(provider: string, model: string) {
    super(
      `LLM model not found: ${provider}/${model} (HTTP 404)`,
      { provider, model },
    );
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
// File System Errors
// ============================================================================

export class FileNotFoundError extends ClawError {
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

export class ConsecutiveParseErrorsExceededError extends ClawError {
  readonly code: ErrorCode = 'CONSECUTIVE_PARSE_ERRORS_EXCEEDED';

  constructor(maxErrors: number, toolNames: string) {
    super(
      `工具输入 JSON 连续解析失败 ${maxErrors} 次（工具: ${toolNames}），终止执行`,
      { maxErrors, toolNames }
    );
  }
}

export class ConsecutiveMaxTokensToolUseError extends ClawError {
  readonly code: ErrorCode = 'CONSECUTIVE_MAX_TOKENS_TOOL_USE_EXCEEDED';

  constructor(maxErrors: number) {
    super(
      `LLM 连续 ${maxErrors} 次 max_tokens 截断 tool_use，终止执行。请减少 system prompt 或 tool schema 体积。`,
      { maxErrors }
    );
  }
}

export class WallTimeExceededError extends ClawError {
  readonly code: ErrorCode = 'MAX_STEPS_EXCEEDED';

  constructor(public readonly deadlineMs: number, public readonly elapsedMs: number) {
    super(
      `Wall-time deadline ${deadlineMs}ms exceeded (elapsed ${elapsedMs}ms)`,
      { deadlineMs, elapsedMs }
    );
  }
}

// ============================================================================
// Programming bug detection (per Coding #5 / phase 342 / r40 反向 3 教训)
// 用于 fail-fast：programming bug 不应被 catch 静默 / 应 surface to top-level
// 4 类锁定 phase 342 / 改列表需用户拍板（业务语义边界）
// ============================================================================

export const PROGRAMMING_BUG_TYPES = [TypeError, ReferenceError, SyntaxError, RangeError] as const;

export type LLMErrorClass = 'permanent' | 'transient' | 'rate_limit' | 'abort' | 'unknown';

/**
 * Classify an LLM error into retry policy category (per phase 730 design).
 *
 * - permanent: 401/403/404 → 0 retry / direct failover
 * - transient: 5xx + network → exponential backoff retry
 * - rate_limit: 429 → Retry-After wait
 * - abort: user signal → immediate throw / 0 retry
 * - unknown: fallback to transient retry
 */
export function classifyLLMError(err: unknown): LLMErrorClass {
  if (err instanceof LLMAuthError || err instanceof LLMModelNotFoundError) return 'permanent';
  if (err instanceof LLMRateLimitError) return 'rate_limit';
  if (err instanceof LLMNetworkError || err instanceof LLMTimeoutError) return 'transient';
  if (err instanceof Error && err.name === 'AbortError') return 'abort';
  if (err instanceof LLMError) return 'transient';  // fallback for unclassified LLMError (5xx etc)
  return 'unknown';
}

export type UserActionHint =
  | 'rotate_api_key'      // LLMAuthError (401/403 non-quota)
  | 'switch_primary'      // LLMModelNotFoundError (404 / model deprecated)
  | 'wait_retry_after'    // LLMRateLimitError (429)
  | 'check_quota'         // LLMAuthError + message contains quota/credit/insufficient
  | null;                 // transient / unknown — no hint shown

export function getUserActionHint(err: unknown): UserActionHint {
  if (err instanceof LLMAuthError) {
    const msg = err.message.toLowerCase();
    if (msg.includes('quota') || msg.includes('credit') || msg.includes('insufficient')) {
      return 'check_quota';
    }
    return 'rotate_api_key';
  }
  if (err instanceof LLMModelNotFoundError) return 'switch_primary';
  if (err instanceof LLMRateLimitError) return 'wait_retry_after';
  return null;
}

export function isProgrammingBug(err: unknown): boolean {
  return PROGRAMMING_BUG_TYPES.some(T => err instanceof T);
}
