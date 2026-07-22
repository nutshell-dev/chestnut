/**
 * Anthropic API Adapter
 * 
 * Implements ProviderAdapter for Anthropic's Claude API using the official SDK.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  LLMResponse,
  ContentBlock,
} from './types.js';
import {
  LLMError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMNetworkError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMEmptyResponseError,
  LLMOutputBudgetExceededError,
  LLMContextExceededError,
} from './errors.js';
import { parseRetryAfter, parseOutputBudgetError } from './_helpers.js';
import type {
  ProviderConfig,
  LLMCallOptions,
  StreamChunk,
} from './types.js';
import { BaseAnthropicAdapter, type AnthropicRequestBody } from './base-anthropic.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from './audit-events.js';
import { makeExternalAbortError, type AbortReason } from './abort-helper.js';
import { assertContentBlocks } from './_block-guards.js';
import { serializeProviderRequest } from './request-unicode.js';

type AnthropicSDKModule = typeof import('@anthropic-ai/sdk');
let anthropicSDKPromise: Promise<AnthropicSDKModule> | undefined;

function loadAnthropicSDK(): Promise<AnthropicSDKModule> {
  anthropicSDKPromise ??= import('@anthropic-ai/sdk');
  return anthropicSDKPromise;
}

/**
 * Anthropic adapter implementation using official SDK
 * Works for native api.anthropic.com and proxies (e.g., OpenRouter).
 */
export class AnthropicAdapter extends BaseAnthropicAdapter {
  readonly name: string;
  readonly model: string;
  protected readonly config: ProviderConfig;
  private readonly baseUrl: string;
  private clientPromise: Promise<Anthropic> | undefined;
  private sdkModule: AnthropicSDKModule | undefined;

  constructor(config: ProviderConfig) {
    super();
    this.config = config;
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  private getClient(): Promise<Anthropic> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  private async createClient(): Promise<Anthropic> {
    const sdk = await loadAnthropicSDK();
    this.sdkModule = sdk;
    return new sdk.default({
      apiKey: this.config.apiKey,
      baseURL: this.baseUrl,
      defaultHeaders: this.config.extraHeaders,
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
      const budget = this.getEffectiveThinkingBudget(body.max_tokens);
      if (budget !== undefined) {
        body.thinking = { type: 'enabled', budget_tokens: budget };
      } else {
        body.thinking = { type: 'adaptive', effort: this.config.thinkingEffort ?? 'high' };
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
  private isLoadError(error: unknown): boolean {
    if (error instanceof LLMError) return false;
    const sdk = this.sdkModule;
    if (sdk && error instanceof sdk.APIError) return false;
    return true;
  }

  private clearClientCache(error: unknown): void {
    if (!this.isLoadError(error)) return;
    this.clientPromise = undefined;
    if (!this.sdkModule) {
      anthropicSDKPromise = undefined;
    }
  }

  private mapSDKError(error: unknown, timeoutMs: number, signal?: AbortSignal): Error {
    // Use name check for mock compatibility in tests
    const errName = (error as Error)?.constructor?.name;
    // SDK 仅对 user-originated abort 抛 APIUserAbortError（对应 signal.aborted）；
    // 其他类 SDK 错误不走此分支。不再显式检查 options.signal，依赖 SDK 自身语义。
    // 若未来 SDK 语义漂移（例如非 user abort 也标此名），这里会误分类为 external abort。
    if (errName === 'APIUserAbortError') {
      return makeExternalAbortError(signal?.reason as AbortReason | undefined);
    }
    // Propagate external abort errors already converted by parseSDKStream or other layers.
    if ((error as Error).name === 'AbortError') {
      return error as Error;
    }
    if (errName === 'RateLimitError') {
      const retryAfter = (error as { headers?: Headers })?.headers?.get?.('retry-after') ?? undefined;
      return new LLMRateLimitError(this.name, parseRetryAfter(retryAfter));
    }
    if (errName === 'APIConnectionTimeoutError') {
      return new LLMTimeoutError(this.name, timeoutMs);
    }
    if (errName === 'APIConnectionError') {
      return new LLMNetworkError(
        this.name,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const sdk = this.sdkModule;
    if (sdk && (error instanceof sdk.AuthenticationError || error instanceof sdk.PermissionDeniedError)) {
      return new LLMAuthError(this.name, error.status ?? 401, error.message);
    }
    if (sdk && error instanceof sdk.NotFoundError) {
      return new LLMModelNotFoundError(this.name, this.model);
    }
    if (sdk && error instanceof sdk.APIError) {
      const apiErr = error as { status?: number; message: string };
      const parsed = parseOutputBudgetError(apiErr.message);
      if (parsed) {
        return new LLMOutputBudgetExceededError(
          this.name,
          parsed.contextLimit,
          parsed.inputTokens,
          parsed.requestedMaxTokens,
          apiErr.message,
        );
      }
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
    serializeProviderRequest(this.name, body);
    const requestOptions: Anthropic.RequestOptions = {
      ...this.buildRequestOptions(),
      timeout: options.timeoutMs ?? this.config.timeoutMs,
      signal: options.signal,
    };
    try {
      const client = await this.getClient();
      const response = await client.messages.create(
        body as Anthropic.MessageCreateParamsNonStreaming,
        requestOptions,
      );
      const data = response as Anthropic.Message;
      return this.parseResponse(data);
    } catch (error) {
      this.clearClientCache(error);
      const mapped = this.mapSDKError(error, options.timeoutMs ?? this.config.timeoutMs, options.signal);
      if (mapped instanceof LLMOutputBudgetExceededError) {
        return this.handleOutputBudgetExceeded(mapped, body, options, requestOptions);
      }
      throw mapped;
    }
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

  private async handleOutputBudgetExceeded(
    err: LLMOutputBudgetExceededError,
    body: AnthropicRequestBody,
    options: LLMCallOptions,
    requestOptions: Anthropic.RequestOptions,
  ): Promise<LLMResponse> {
    const adjusted = err.contextLimit - err.inputTokens;
    const auditPayload = [
      `provider=${this.providerName}`,
      `model=${this.model}`,
      `original_max_tokens=${body.max_tokens}`,
      `adjusted_max_tokens=${adjusted}`,
      `context_limit=${err.contextLimit}`,
      `input_tokens=${err.inputTokens}`,
    ];

    if (adjusted > 0) {
      this.assertThinkingBudgetFits(adjusted, auditPayload);
      const retryBody = this.buildRequestBody({ ...options, maxTokens: adjusted });
      try {
        const client = await this.getClient();
        const response = await client.messages.create(
          retryBody as Anthropic.MessageCreateParamsNonStreaming,
          requestOptions,
        );
        return this.parseResponse(response);
      } catch (retryError) {
        throw this.mapSDKError(retryError, options.timeoutMs ?? this.config.timeoutMs, options.signal);
      }
    }

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

  /**
   * Stream LLM response using SDK
   */
  async* stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk> {
    const body = this.buildRequestBody(options);
    serializeProviderRequest(this.name, body);
    const requestOptions: Anthropic.RequestOptions = {
      ...this.buildRequestOptions(),
      timeout: options.timeoutMs ?? this.config.timeoutMs,
      signal: options.signal,
    };
    let yieldedChunks = false;
    try {
      const client = await this.getClient();
      const sdkStream = client.messages.stream(
        body as Anthropic.MessageStreamParams,
        requestOptions,
      );
      for await (const chunk of this.parseSDKStream(sdkStream, options.signal)) {
        yieldedChunks = true;
        yield chunk;
      }
    } catch (error) {
      this.clearClientCache(error);
      const mapped = this.mapSDKError(error, options.timeoutMs ?? this.config.timeoutMs, options.signal);
      if (mapped instanceof LLMOutputBudgetExceededError) {
        if (yieldedChunks) {
          // Output already started — don't retry, propagate the error.
          // The orchestrator should handle as an interrupted stream.
          throw mapped;
        }
        const adjusted = mapped.contextLimit - mapped.inputTokens;
        const auditPayload = [
          `provider=${this.providerName}`,
          `model=${this.model}`,
          `original_max_tokens=${body.max_tokens}`,
          `adjusted_max_tokens=${adjusted}`,
          `context_limit=${mapped.contextLimit}`,
          `input_tokens=${mapped.inputTokens}`,
        ];
        if (adjusted > 0) {
          this.assertThinkingBudgetFits(adjusted, auditPayload);
          const retryBody = this.buildRequestBody({ ...options, maxTokens: adjusted });
          try {
            const client = await this.getClient();
            const retryStream = client.messages.stream(
              retryBody as Anthropic.MessageStreamParams,
              requestOptions,
            );
            yield* this.parseSDKStream(retryStream, options.signal);
            return;
          } catch (retryError) {
            throw this.mapSDKError(retryError, options.timeoutMs ?? this.config.timeoutMs, options.signal);
          }
        }
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
      throw mapped;
    }
  }

  /**
   * Parse SDK stream events to StreamChunk format
   */
  private async* parseSDKStream(
    stream: ReturnType<Anthropic['messages']['stream']>,
    signal?: AbortSignal,
  ): AsyncIterableIterator<StreamChunk> {
    let currentToolId = '';
    let currentToolName = '';

    for await (const event of stream) {
      if (signal?.aborted) {
        throw makeExternalAbortError(signal.reason as AbortReason | undefined);
      }
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

      assertContentBlocks(m.content);
      const blocks = m.content;
      if (addCache && blocks.length > 0) {
        const copy = blocks.map(b => ({ ...b }));
        const last = copy[copy.length - 1];
        if (last) (last as Record<string, unknown>).cache_control = { type: 'ephemeral' };
        return { role, content: copy };
      }
      return { role, content: blocks };
    });
  }

  /**
   * Parse Anthropic response to our LLMResponse format
   */
  private parseResponse(data: Anthropic.Message): LLMResponse {
    if (!data.content || data.content.length === 0) {
      throw new LLMEmptyResponseError(this.name);
    }
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
