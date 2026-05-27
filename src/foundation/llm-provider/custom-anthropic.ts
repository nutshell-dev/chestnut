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
} from './errors.js';
import { throwHttpErrorResponse } from './_helpers.js';
import type {
  ProviderConfig,
  LLMCallOptions,
  StreamChunk,
} from './types.js';
import { THINKING_TOKEN_RESERVE, STREAM_MAX_DURATION_MS, STREAM_IDLE_MAX_MS } from './constants.js';
import { BaseAnthropicAdapter, type AnthropicRequestBody } from './base-anthropic.js';
import { withCombinedAbortSignal, classifyFetchAbortError } from './abort-helper.js';
import { parseAnthropicSSEStream } from './custom-anthropic-sse-parser.js';
import { parseAnthropicResponse, type AnthropicResponse } from './custom-anthropic-response-parser.js';

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
   * Build request body with enabled thinking only (no adaptive mode for custom providers)
   */
  private buildRequestBody(options: LLMCallOptions): AnthropicRequestBody {
    const body = this.buildBaseRequestBody(options);

    // Custom providers only support enabled mode (no adaptive)
    if (this.config.thinking) {
      const budget = this.config.thinkingBudgetTokens
        ?? Math.max(1, body.max_tokens - THINKING_TOKEN_RESERVE);
      body.thinking = { type: 'enabled', budget_tokens: budget };
      delete body.temperature;
    }

    return body;
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
        body: JSON.stringify(body),
        signal: abortHandle.signal,
      });

      if (!response.ok) {
        await throwHttpErrorResponse(this.name, response);
      }

      const data = await response.json() as AnthropicResponse;
      return parseAnthropicResponse(data);

    } catch (error) {
      const classified = classifyFetchAbortError(error, signal, timeout, this.name);
      if (classified) throw classified;

      if (error instanceof LLMError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
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
        body: JSON.stringify({ ...body, stream: true }),
        signal: abortHandle.signal,
      });

      if (!response.ok) await throwHttpErrorResponse(this.name, response);

      // 进入 stream 阶段：切换 timer 为总时长保护
      abortHandle.enterStreamPhase(STREAM_MAX_DURATION_MS);
      const idleTimeoutMs = Math.min(timeout, STREAM_IDLE_MAX_MS);
      yield* parseAnthropicSSEStream(response, abortHandle, idleTimeoutMs, this.name, this.onStreamParseError);
    } catch (error) {
      const classified = classifyFetchAbortError(error, signal, timeout, this.name);
      if (classified) throw classified;
      if (error instanceof LLMError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new LLMNetworkError(
        this.name,
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      cleanup();
    }
  }

}
