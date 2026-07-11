/**
 * LLM Provider (L1) error classes — thrown by provider adapters.
 *
 * Canonical owner per M#5: L1 modules do not depend on L2b. Since L1 provider
 * adapters (anthropic, openai, gemini, custom-anthropic) throw these errors,
 * they must live in L1, not L2b.
 *
 * classifyLLMError / getUserActionHint (retry policy) remain in L2b
 * llm-orchestrator/errors.ts, importing base classes from here.
 */

import { formatErr } from '../node-utils/index.js';

export type LLMErrorCode =
  | 'LLM_CALL_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_AUTH_FAILED'
  | 'LLM_NETWORK_FAILED'
  | 'LLM_EMPTY_RESPONSE'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_CONTEXT_EXCEEDED'
  | 'LLM_OUTPUT_BUDGET_EXCEEDED'
  | 'LLM_CIRCUIT_BREAKER_OPEN'
  | 'LLM_STREAM_ABORTED';

export class LLMError extends Error {
  readonly code: LLMErrorCode = 'LLM_CALL_FAILED';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();

  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    if (cause) this.cause = cause;
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

export class LLMRateLimitError extends LLMError {
  readonly code: LLMErrorCode = 'LLM_RATE_LIMITED';
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
  readonly code: LLMErrorCode = 'LLM_TIMEOUT';
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
  readonly code: LLMErrorCode = 'LLM_AUTH_FAILED';
  constructor(provider: string, statusCode: number, message?: string) {
    super(
      message ?? `LLM auth failed for ${provider} (HTTP ${statusCode})`,
      { provider, statusCode },
    );
  }
}

export class LLMNetworkError extends LLMError {
  readonly code: LLMErrorCode = 'LLM_NETWORK_FAILED';
  constructor(provider: string, cause?: Error) {
    super(
      `LLM network failure for ${provider}${cause ? `: ${cause.message}` : ''}`,
      { provider },
      cause,
    );
  }
}

export class LLMEmptyResponseError extends LLMError {
  readonly code: LLMErrorCode = 'LLM_EMPTY_RESPONSE';
  constructor(provider: string) {
    super(
      `LLM returned empty response from ${provider}`,
      { provider },
    );
  }
}

export class LLMModelNotFoundError extends LLMError {
  readonly code: LLMErrorCode = 'LLM_MODEL_NOT_FOUND';
  constructor(provider: string, model: string, providerMessage?: string) {
    const base = `LLM model not found: provider "${provider}" rejected model "${model}" (HTTP 404)`;
    const detail = providerMessage
      ? `\nProvider response: ${providerMessage.slice(0, 200)}`
      : '';
    super(base + detail, { provider, model, providerMessage });
  }
}

export class LLMContextExceededError extends LLMError {
  readonly code: LLMErrorCode = 'LLM_CONTEXT_EXCEEDED';
  readonly provider: string;
  readonly status: number;
  readonly providerMessage: string;
  constructor(provider: string, status: number, providerMessage: string) {
    super(
      `LLM context exceeded for ${provider} (HTTP ${status}): ${providerMessage.slice(0, 200)}`,
      { provider, status },
    );
    this.provider = provider;
    this.status = status;
    this.providerMessage = providerMessage;
  }
}

export class LLMOutputBudgetExceededError extends LLMError {
  readonly code: LLMErrorCode = 'LLM_OUTPUT_BUDGET_EXCEEDED';
  readonly provider: string;
  readonly contextLimit: number;
  readonly inputTokens: number;
  readonly requestedMaxTokens: number;

  constructor(
    provider: string,
    contextLimit: number,
    inputTokens: number,
    requestedMaxTokens: number,
    message: string,
  ) {
    super(
      message,
      { provider, contextLimit, inputTokens, requestedMaxTokens },
    );
    this.provider = provider;
    this.contextLimit = contextLimit;
    this.inputTokens = inputTokens;
    this.requestedMaxTokens = requestedMaxTokens;
  }
}

export class LLMCircuitBreakerOpenError extends LLMError {
  readonly code: LLMErrorCode = 'LLM_CIRCUIT_BREAKER_OPEN';
  constructor(provider: string) {
    super(`Circuit breaker open for ${provider}`, { provider });
  }
}

export class LLMStreamAbortedError extends LLMError {
  readonly code: LLMErrorCode = 'LLM_STREAM_ABORTED';
  constructor(provider: string, reason?: string) {
    super(
      `LLM stream aborted for ${provider}${reason ? `: ${reason}` : ''}`,
      { provider, reason },
    );
  }
}

