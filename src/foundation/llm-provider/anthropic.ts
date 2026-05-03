/**
 * Anthropic API Adapter
 * 
 * Implements ProviderAdapter for Anthropic's Claude API using the official SDK.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMResponse,
  ContentBlock,
} from '../../types/message.js';
import {
  LLMError,
  LLMRateLimitError,
  LLMTimeoutError,
} from '../../types/errors.js';
import type {
  ProviderConfig,
  LLMCallOptions,
  StreamChunk,
} from './types.js';
import { THINKING_TOKEN_RESERVE, STREAM_MAX_DURATION_MS } from '../../constants.js';
import { BaseAnthropicAdapter, type AnthropicRequestBody } from './base-anthropic.js';
import { makeExternalAbortError, type AbortReason } from './abort-helper.js';

/**
 * Anthropic adapter implementation using official SDK
 * Works for native api.anthropic.com and proxies (e.g., OpenRouter).
 */
export class AnthropicAdapter extends BaseAnthropicAdapter {
  readonly name: string;
  readonly model: string;
  protected readonly config: ProviderConfig;
  private readonly baseUrl: string;
  private readonly client: Anthropic;

  constructor(config: ProviderConfig) {
    super();
    this.config = config;
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: this.baseUrl,
      defaultHeaders: config.extraHeaders,
      maxRetries: 0,
    });
  }

  /**
   * Build request body for Anthropic API
   * Extends base body with thinking support
   */
  private buildRequestBody(options: LLMCallOptions): AnthropicRequestBody {
    const body = this.buildBaseRequestBody(options);

    // Extended thinking (requires no temperature)
    if (this.config.thinking) {
      const mode = this.config.thinkingMode ?? 'adaptive';
      if (mode === 'adaptive') {
        body.thinking = { type: 'adaptive', effort: this.config.thinkingEffort ?? 'high' };
      } else {
        const budget = this.config.thinkingBudgetTokens
          ?? Math.max(1, body.max_tokens - THINKING_TOKEN_RESERVE);
        body.thinking = { type: 'enabled', budget_tokens: budget };
      }
      delete body.temperature;
    }

    return body;
  }

  /**
   * Build request options with beta headers for enabled thinking mode
   */
  private buildRequestOptions(): Anthropic.RequestOptions {
    if (this.config.thinking && (this.config.thinkingMode ?? 'adaptive') === 'enabled') {
      return { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } };
    }
    return {};
  }

  /**
   * Map SDK errors to our error types
   */
  private mapSDKError(error: unknown, timeoutMs: number, signal?: AbortSignal): Error {
    // Use name check for mock compatibility in tests
    const errName = (error as Error)?.constructor?.name;
    // SDK 仅对 user-originated abort 抛 APIUserAbortError（对应 signal.aborted）；
    // 其他类 SDK 错误不走此分支。不再显式检查 options.signal，依赖 SDK 自身语义。
    // 若未来 SDK 语义漂移（例如非 user abort 也标此名），这里会误分类为 external abort。
    if (errName === 'APIUserAbortError') {
      return makeExternalAbortError(signal?.reason as AbortReason | undefined);
    }
    if (errName === 'RateLimitError') {
      const retryAfter = (error as { headers?: Headers })?.headers?.get?.('retry-after');
      return new LLMRateLimitError(this.name, retryAfter ? parseInt(retryAfter, 10) : undefined);
    }
    if (errName === 'APIConnectionTimeoutError') {
      return new LLMTimeoutError(this.name, timeoutMs);
    }
    if (errName === 'APIError') {
      const apiErr = error as { status?: number; message: string };
      return new LLMError(
        `Provider ${this.name} error (${apiErr.status ?? 'unknown'}): ${apiErr.message}`,
        { provider: this.name, status: apiErr.status },
      );
    }
    if (error instanceof LLMError) return error;
    return new LLMError(
      `LLM call failed: ${(error as Error).message}`,
      { provider: this.name },
    );
  }

  /**
   * Make a single LLM call
   */
  async call(options: LLMCallOptions): Promise<LLMResponse> {
    const body = this.buildRequestBody(options);
    const requestOptions: Anthropic.RequestOptions = {
      ...this.buildRequestOptions(),
      timeout: options.timeoutMs ?? this.config.timeoutMs,
      signal: options.signal,
    };
    try {
      const response = await this.client.messages.create(
        body as Anthropic.MessageCreateParamsNonStreaming,
        requestOptions,
      );
      return this.parseResponse(response);
    } catch (error) {
      throw this.mapSDKError(error, options.timeoutMs ?? this.config.timeoutMs, options.signal);
    }
  }

  /**
   * Stream LLM response using SDK
   */
  async* stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk> {
    const body = this.buildRequestBody(options);
    const requestOptions: Anthropic.RequestOptions = {
      ...this.buildRequestOptions(),
      timeout: STREAM_MAX_DURATION_MS,
      signal: options.signal,
    };
    try {
      const sdkStream = this.client.messages.stream(
        body as Anthropic.MessageStreamParams,
        requestOptions,
      );
      yield* this.parseSDKStream(sdkStream);
    } catch (error) {
      throw this.mapSDKError(error, STREAM_MAX_DURATION_MS, options.signal);
    }
  }

  /**
   * Parse SDK stream events to StreamChunk format
   */
  private async* parseSDKStream(
    stream: ReturnType<Anthropic['messages']['stream']>,
  ): AsyncIterableIterator<StreamChunk> {
    let currentToolId = '';
    let currentToolName = '';

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          currentToolId = block.id;
          currentToolName = block.name;
          yield { type: 'tool_use_start', toolUse: { id: block.id, name: block.name, partialInput: '' } };
        }
        // thinking / redacted_thinking block_start: 无需 yield
      } else if (event.type === 'content_block_delta') {
        const d = event.delta;
        if (d.type === 'text_delta') {
          yield { type: 'text_delta', delta: d.text };
        } else if (d.type === 'thinking_delta') {
          yield { type: 'thinking_delta', delta: d.thinking };
        } else if (d.type === 'signature_delta') {
          yield { type: 'thinking_signature', signature: d.signature };
        } else if (d.type === 'input_json_delta') {
          yield { type: 'tool_use_delta', toolUse: { id: currentToolId, name: currentToolName, partialInput: d.partial_json } };
        }
      } else if (event.type === 'message_delta') {
        yield {
          type: 'done',
          stopReason: event.delta.stop_reason ?? 'end_turn',
          usage: event.usage
            ? { inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 }
            : undefined,
        };
      }
    }
  }

  /**
   * Simplified message formatting for native Anthropic API (api.anthropic.com).
   *
   * Unlike the base implementation, we don't need MiniMax string compatibility
   * or dropThinkingBlocks — Anthropic's API accepts array format for all messages
   * and handles thinking blocks in history natively.
   *
   * Only concern: add cache_control to the last user message for prompt caching.
   */
  protected override formatMessages(
    messages: Array<{ role: string; content: unknown }>,
  ): Array<{ role: string; content: string | unknown[] }> {
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }

    return messages.map((m, idx) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const addCache = idx === lastUserIdx;

      if (!Array.isArray(m.content)) {
        if (addCache) {
          return { role, content: [{ type: 'text', text: m.content as string, cache_control: { type: 'ephemeral' } }] };
        }
        return { role, content: m.content as string };
      }

      const blocks = m.content as unknown[];
      if (addCache && blocks.length > 0) {
        const copy = [...blocks];
        copy[copy.length - 1] = {
          ...(copy[copy.length - 1] as Record<string, unknown>),
          cache_control: { type: 'ephemeral' },
        };
        return { role, content: copy };
      }
      return { role, content: blocks };
    });
  }

  /**
   * Parse Anthropic response to our LLMResponse format
   */
  private parseResponse(data: Anthropic.Message): LLMResponse {
    // Store raw content blocks including unknown types (think, reasoning, etc.)
    // This aligns with MVP behavior - don't filter, let LLM handle its own blocks
    const content = data.content as ContentBlock[];

    return {
      content,
      stop_reason: data.stop_reason ?? 'end_turn',
      usage: data.usage,
      model: data.model,
    };
  }
}
