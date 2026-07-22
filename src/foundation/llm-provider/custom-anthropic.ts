/**
 * Custom Anthropic-compatible Adapter
 * 
 * For third-party providers with Anthropic-compatible API (MiniMax, etc.)
 * Uses raw fetch with Authorization: Bearer instead of SDK.
 */

import type {
  LLMResponse,
} from '../llm-provider/types.js';
import {
  LLMError,
  LLMNetworkError,
  LLMContextExceededError,
} from './errors.js';
import { throwHttpErrorResponse, parseOutputBudgetError } from './_helpers.js';
import { isAbortError } from './is-abort-error.js';
import type {
  ProviderConfig,
  LLMCallOptions,
  StreamChunk,
} from './types.js';
import { THINKING_TOKEN_RESERVE, STREAM_MAX_DURATION_MS, STREAM_IDLE_MAX_MS } from './constants.js';
import { BaseAnthropicAdapter, type AnthropicRequestBody } from './base-anthropic.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from './audit-events.js';
import { withCombinedAbortSignal, classifyFetchAbortError } from './abort-helper.js';
import { parseAnthropicSSEStream } from './custom-anthropic-sse-parser.js';
import { parseAnthropicResponse, type AnthropicResponse } from './custom-anthropic-response-parser.js';
import { serializeProviderRequest } from './request-unicode.js';

/**
 * Custom Anthropic adapter for third-party providers
 */
export class CustomAnthropicAdapter extends BaseAnthropicAdapter {
  readonly name: string;
  readonly model: string;
  protected readonly config: ProviderConfig;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    super();
    this.config = config;
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  /**
   * Custom providers only support enabled mode (no adaptive).
   */
  protected override getEffectiveThinkingBudget(maxTokens: number): number | undefined {
    if (!this.config.thinking) return undefined;
    return this.config.thinkingBudgetTokens
      ?? Math.max(1, maxTokens - THINKING_TOKEN_RESERVE);
  }

  /**
   * Build request body with enabled thinking only (no adaptive mode for custom providers)
   */
  private buildRequestBody(options: LLMCallOptions): AnthropicRequestBody {
    const body = this.buildBaseRequestBody(options);

    if (this.config.thinking) {
      const budget = this.getEffectiveThinkingBudget(body.max_tokens);
      if (budget !== undefined) {
        body.thinking = { type: 'enabled', budget_tokens: budget };
        delete body.temperature;
      }
    }

    return body;
  }

  /**
   * Ensure adjusted output budget can still accommodate the effective thinking budget.
   */
  private assertThinkingBudgetFits(adjusted: number, auditPayload: string[]): void {
    const effectiveBudget = this.getEffectiveThinkingBudget(adjusted);
    const conflict = effectiveBudget !== undefined && adjusted <= effectiveBudget;
    this.auditLog?.write(
      LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED,
      ...auditPayload,
      ...(effectiveBudget !== undefined ? [`effective_thinking_budget=${effectiveBudget}`] : []),
      ...(conflict ? [`reason=thinking_budget_conflict`, `retry=false`] : []),
    );
    if (conflict) {
      throw new LLMContextExceededError(
        this.name,
        400,
        `Output budget adjusted to ${adjusted} tokens, but effective thinking budget is ${effectiveBudget}. ` +
          `Reduce thinking budget or trim input context.`,
      );
    }
  }

  /**
   * Auth headers for custom providers (Bearer token)
   */
  private get authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      'anthropic-version': '2023-06-01',
      ...this.config.extraHeaders,
    };
  }

  /**
   * Make a single LLM call
   */
  async call(options: LLMCallOptions): Promise<LLMResponse> {
    const { timeoutMs, signal } = options;
    const body = this.buildRequestBody(options);

    const timeout = timeoutMs ?? this.config.timeoutMs;
    const [abortHandle, cleanup] = withCombinedAbortSignal(signal, timeout);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.authHeaders,
        body: serializeProviderRequest(this.name, body),
        signal: abortHandle.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const parsed = parseOutputBudgetError(errorText);
        if (parsed) {
          const adjusted = parsed.contextLimit - parsed.inputTokens;
          const auditPayload = [
            `provider=${this.providerName}`,
            `model=${this.model}`,
            `original_max_tokens=${body.max_tokens}`,
            `adjusted_max_tokens=${adjusted}`,
            `context_limit=${parsed.contextLimit}`,
            `input_tokens=${parsed.inputTokens}`,
          ];
          if (adjusted > 0) {
            this.assertThinkingBudgetFits(adjusted, auditPayload);
            const retryBody = this.buildRequestBody({ ...options, maxTokens: adjusted });
            const retryResponse = await fetch(`${this.baseUrl}/v1/messages`, {
              method: 'POST',
              headers: this.authHeaders,
              body: serializeProviderRequest(this.name, retryBody),
              signal: abortHandle.signal,
            });
            if (retryResponse.ok) {
              const data = await retryResponse.json() as AnthropicResponse;
              return parseAnthropicResponse(data);
            }
            await throwHttpErrorResponse(this.name, this.model, retryResponse);
          } else {
            this.auditLog?.write(
              LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED,
              ...auditPayload,
              `reason=nonpositive_adjusted`,
            );
            throw new LLMContextExceededError(
              this.name,
              400,
              `Output budget exhausted after adjustment: ${adjusted} tokens available`,
            );
          }
        }
        await throwHttpErrorResponse(this.name, this.model, response, errorText);
      }

      const data = await response.json() as AnthropicResponse;
      return parseAnthropicResponse(data);

    } catch (error) {
      const classified = classifyFetchAbortError(error, signal, timeout, this.name);
      if (classified) throw classified;

      if (error instanceof LLMError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw error;
      }

      throw new LLMNetworkError(
        this.name,
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      cleanup();
    }
  }

  /**
   * Stream LLM response with true SSE parsing
   */
  async* stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk> {
    const { timeoutMs, signal } = options;
    const body = this.buildRequestBody(options);

    const timeout = timeoutMs ?? this.config.timeoutMs;
    const [abortHandle, cleanup] = withCombinedAbortSignal(signal, timeout);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.authHeaders,
        body: serializeProviderRequest(this.name, { ...body, stream: true }),
        signal: abortHandle.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const parsed = parseOutputBudgetError(errorText);
        if (parsed) {
          const adjusted = parsed.contextLimit - parsed.inputTokens;
          const auditPayload = [
            `provider=${this.providerName}`,
            `model=${this.model}`,
            `original_max_tokens=${body.max_tokens}`,
            `adjusted_max_tokens=${adjusted}`,
            `context_limit=${parsed.contextLimit}`,
            `input_tokens=${parsed.inputTokens}`,
          ];
          if (adjusted > 0) {
            this.assertThinkingBudgetFits(adjusted, auditPayload);
            const retryBody = this.buildRequestBody({ ...options, maxTokens: adjusted });
            const retryResponse = await fetch(`${this.baseUrl}/v1/messages`, {
              method: 'POST',
              headers: this.authHeaders,
              body: serializeProviderRequest(this.name, { ...retryBody, stream: true }),
              signal: abortHandle.signal,
            });
            if (retryResponse.ok) {
              // 进入 stream 阶段：切换 timer 为总时长保护
              abortHandle.enterStreamPhase(STREAM_MAX_DURATION_MS);
              const idleTimeoutMs = Math.min(timeout, STREAM_IDLE_MAX_MS);
              const auditLog = this.config.auditLog;
              const onParseError = auditLog
                ? (event: { provider: string; raw: string; error: string }) => {
                    this.onStreamParseError?.({
                      provider: event.provider,
                      raw: auditLog.preview(event.raw),
                      error: event.error,
                    });
                  }
                : this.onStreamParseError;
              yield* parseAnthropicSSEStream(retryResponse, abortHandle, idleTimeoutMs, this.name, onParseError);
              return;
            }
            await throwHttpErrorResponse(this.name, this.model, retryResponse, await retryResponse.text().catch(() => ''));
          } else {
            this.auditLog?.write(
              LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED,
              ...auditPayload,
              `reason=nonpositive_adjusted`,
            );
            throw new LLMContextExceededError(
              this.name,
              400,
              `Output budget exhausted after adjustment: ${adjusted} tokens available`,
            );
          }
        }
        await throwHttpErrorResponse(this.name, this.model, response, errorText);
      }

      // 进入 stream 阶段：切换 timer 为总时长保护
      abortHandle.enterStreamPhase(STREAM_MAX_DURATION_MS);
      const idleTimeoutMs = Math.min(timeout, STREAM_IDLE_MAX_MS);
      const auditLog = this.config.auditLog;
      const onParseError = auditLog
        ? (event: { provider: string; raw: string; error: string }) => {
            this.onStreamParseError?.({
              provider: event.provider,
              raw: auditLog.preview(event.raw),
              error: event.error,
            });
          }
        : this.onStreamParseError;
      yield* parseAnthropicSSEStream(response, abortHandle, idleTimeoutMs, this.name, onParseError);
    } catch (error) {
      const classified = classifyFetchAbortError(error, signal, timeout, this.name);
      if (classified) throw classified;
      if (error instanceof LLMError) throw error;
      if (isAbortError(error)) throw error;
      throw new LLMNetworkError(
        this.name,
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      cleanup();
    }
  }

}
