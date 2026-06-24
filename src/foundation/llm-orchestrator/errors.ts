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

import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMNetworkError,
  LLMTimeoutError,
  LLMContextExceededError,
} from '../llm-provider/errors.js';
import type { ErrorCode } from '../errors.js';
import { isAbortError } from '../llm-provider/is-abort-error.js';

export { LLMError, LLMRateLimitError, LLMTimeoutError, LLMAuthError, LLMNetworkError, LLMEmptyResponseError, LLMModelNotFoundError, LLMContextExceededError, LLMCircuitBreakerOpenError, LLMStreamAbortedError } from '../llm-provider/errors.js';

export class LLMAllProvidersFailedError extends LLMError {
  readonly code: ErrorCode = 'LLM_ALL_PROVIDERS_FAILED';
  readonly failures: Array<{ provider: string; error: Error }>;

  constructor(failures: Array<{ provider: string; error: Error }>) {
    const summary = failures
      .map(f => `${f.provider} (${f.error.message})`)
      .join(', ');
    super(
      `All LLM providers failed: ${summary}`,
      { failures: failures.map(f => ({ provider: f.provider, error: f.error.message })) }
    );
    this.failures = failures;
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
