/**
 * LLMOrchestrator (L2b) error types — retry policy + all-providers-failed.
 *
 * LLM base error classes (LLMError, LLMRateLimitError, etc.) live in L1
 * llm-provider/errors.ts per M#5 (L1 provider adapters throw them, so they
 * must not be defined in a higher layer).
 *
 * classifyLLMError / getUserActionHint are retry-policy functions that
 * operate on L1 error classes; they belong to L2b where retry logic lives.
 */

import { formatErr } from '../node-utils/index.js';
import { isAbortError } from '../llm-provider/is-abort-error.js';
import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMNetworkError,
  LLMTimeoutError,
  LLMContextExceededError,
} from '../llm-provider/errors.js';

export { LLMError, LLMRateLimitError, LLMTimeoutError, LLMAuthError, LLMNetworkError, LLMEmptyResponseError, LLMModelNotFoundError, LLMContextExceededError, LLMCircuitBreakerOpenError, LLMStreamAbortedError } from '../llm-provider/errors.js';

export type OrchestratorErrorCode = 'LLM_ALL_PROVIDERS_FAILED';

export class LLMAllProvidersFailedError extends Error {
  readonly code: OrchestratorErrorCode = 'LLM_ALL_PROVIDERS_FAILED';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();
  readonly failures: Array<{ provider: string; error: Error }>;

  constructor(failures: Array<{ provider: string; error: Error }>) {
    const summary = failures
      .map(f => `${f.provider} (${f.error.message})`)
      .join(', ');
    super(
      `All LLM providers failed: ${summary}`,
    );
    this.name = this.constructor.name;
    this.failures = failures;
    this.context = { failures: failures.map(f => ({ provider: f.provider, error: f.error.message })) };
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      ...(this.cause !== undefined && { cause: formatErr(this.cause) }),
    };
  }
}

export type LLMErrorClass = 'permanent' | 'transient' | 'rate_limit' | 'abort' | 'context_exceeded' | 'unknown';

export function classifyLLMError(err: unknown): LLMErrorClass {
  // phase 690: context_exceeded 必须先于 LLMError 通用判定（subclass 关系）
  if (err instanceof LLMContextExceededError) return 'context_exceeded';
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('quota') || msg.includes('insufficient') || msg.includes('credit') || msg.includes('billing')) {
      return 'permanent';
    }
  }
  if (err instanceof LLMAuthError || err instanceof LLMModelNotFoundError) return 'permanent';
  if (err instanceof LLMRateLimitError) return 'rate_limit';
  if (err instanceof LLMNetworkError || err instanceof LLMTimeoutError) return 'transient';
  if (isAbortError(err)) return 'abort';
  if (err instanceof LLMError) return 'transient';
  return 'unknown';
}

/**
 * Broad context-exceeded detection. Handles three paths from the orchestrator:
 *   1. Single-provider LLMContextExceededError (orchestrator throw-through, instanceof)
 *   2. All-providers LLMError("...context_window_exceeded...") (streaming generator, regex)
 *   3. SDK-adapter non-standard error messages matching Anthropic/OpenAI context patterns (regex)
 *
 * Regex mirrors Runtime._isContextExceededError (src/core/runtime/runtime.ts:1226);
 * after this extraction, Runtime._isContextExceededError will delegate here.
 */
export function isContextExceededError(err: unknown): boolean {
  if (err instanceof LLMContextExceededError) return true;
  if (err instanceof Error) {
    const msg = err.message;
    return /maximum context length|context.{0,30}exceed|prompt is too long|reduce the length of/i.test(msg);
  }
  return false;
}

export type UserActionHint =
  | 'rotate_api_key'
  | 'switch_primary'
  | 'wait_retry_after'
  | 'check_quota'
  | 'check_endpoint'
  | 'check_network'
  | null;

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
  if (err instanceof LLMTimeoutError) return 'check_endpoint';
  if (err instanceof LLMNetworkError) return 'check_network';
  return null;
}
