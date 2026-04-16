/**
 * Custom Anthropic-compatible Adapter
 * 
 * For third-party providers with Anthropic-compatible API (MiniMax, etc.)
 * Uses raw fetch with Authorization: Bearer instead of SDK.
 */

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

/**
 * Anthropic API response
 */
interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; [key: string]: unknown }>;
  model: string;
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

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

    // Setup timeout
    const timeout = timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Combine with external signal if provided
    const onAbort = signal ? () => controller.abort() : undefined;
    if (signal && onAbort) {
      signal.addEventListener('abort', onAbort);
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const data = await response.json() as AnthropicResponse;
      return this.parseResponse(data);

    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // 区分用户主动中断（Ctrl+C）和内部超时
        if (signal?.aborted) {
          const err = new Error('Execution aborted');
          err.name = 'AbortError';
          throw err;
        }
        // 内部超时
        throw new LLMTimeoutError(this.name, timeout);
      }

      if (error instanceof LLMError) {
        throw error;
      }

      throw new LLMError(
        `LLM call failed: ${(error as Error).message}`,
        { provider: this.name }
      );
    } finally {
      clearTimeout(timeoutId);
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * Stream LLM response with true SSE parsing
   */
  async* stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk> {
    const { timeoutMs, signal } = options;
    const body = this.buildRequestBody(options);

    // fetch 阶段保留初始 timeout（等待服务器首次响应）
    const timeout = timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), timeout);
    const onAbort = signal ? () => controller.abort() : undefined;
    if (signal && onAbort) signal.addEventListener('abort', onAbort);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });

      if (!response.ok) await this.handleErrorResponse(response);

      // fetch 成功，清除初始 timeout，由 parseSSEStream 管理 idle timeout
      clearTimeout(timeoutId);

      // 总超时兜底：无论 idle timer 是否生效，N 分钟后强制 abort
      const maxTimer = setTimeout(() => controller.abort(), STREAM_MAX_DURATION_MS);
      try {
        yield* this.parseSSEStream(response, controller, timeout);
      } finally {
        clearTimeout(maxTimer);
      }
    } catch (error) {
      // 与 call() 相同的错误处理
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (signal?.aborted) {
          const err = new Error('Execution aborted');
          err.name = 'AbortError';
          throw err;
        }
        throw new LLMTimeoutError(this.name, timeout);
      }
      if (error instanceof LLMError) throw error;
      throw new LLMError(`LLM stream failed: ${(error as Error).message}`, { provider: this.name });
    } finally {
      clearTimeout(timeoutId);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Parse Anthropic SSE stream
   */
  private async* parseSSEStream(
    response: Response,
    controller: AbortController,
    idleTimeoutMs: number,
  ): AsyncIterableIterator<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    let currentToolId = '';
    let currentToolName = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        clearTimeout(idleTimer);
        if (done) break;
        idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data);
          } catch (err) {
            console.warn(`[anthropic] Failed to parse SSE event, skipping. data="${data.slice(0, 100)}" err=${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          if (event.type === 'content_block_start') {
            const block = event.content_block as Record<string, unknown>;
            if (block.type === 'tool_use') {
              currentToolId = block.id as string ?? '';
              currentToolName = block.name as string ?? '';
              yield {
                type: 'tool_use_start',
                toolUse: {
                  id: currentToolId,
                  name: currentToolName,
                  partialInput: '',
                },
              };
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta as Record<string, unknown>;
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', delta: delta.text as string };
            } else if (delta.type === 'thinking_delta') {
              yield { type: 'thinking_delta', delta: delta.thinking as string };
            } else if (delta.type === 'signature_delta') {
              yield { type: 'thinking_signature', signature: delta.signature as string };
            } else if (delta.type === 'input_json_delta') {
              yield {
                type: 'tool_use_delta',
                toolUse: { id: currentToolId, name: currentToolName, partialInput: delta.partial_json as string },
              };
            }
          } else if (event.type === 'message_delta') {
            const usage = event.usage as Record<string, number> | undefined;
            const delta = event.delta as Record<string, unknown> | undefined;
            yield {
              type: 'done',
              usage: usage ? {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
              } : undefined,
              stopReason: delta?.stop_reason as string | undefined,
            };
          } else if (event.type === 'error') {
            const errorObj = event.error as Record<string, unknown> | undefined;
            const errorType = errorObj?.type as string ?? 'unknown_error';
            const errorMsg = errorObj?.message as string ?? JSON.stringify(event);
            if (errorType === 'overloaded_error') {
              throw new LLMRateLimitError(this.name);
            }
            throw new LLMError(
              `${errorType}: ${errorMsg}`,
              { provider: this.name }
            );
          }
        }
      }
    } finally {
      clearTimeout(idleTimer);
      try {
        reader.releaseLock();
      } catch {
        // Ignore: pending read during timeout/abort; stream will be GC'd
      }
    }
  }

  /**
   * Parse Anthropic response to our LLMResponse format
   */
  private parseResponse(data: AnthropicResponse): LLMResponse {
    const content = data.content as ContentBlock[];

    return {
      content,
      stop_reason: data.stop_reason ?? 'end_turn',
      usage: data.usage,
      model: data.model,
    };
  }

  /**
   * Handle HTTP error responses
   */
  private async handleErrorResponse(response: Response): Promise<void> {
    const status = response.status;
    let errorText: string;

    try {
      const errorData = await response.json();
      errorText = (errorData as { error?: { message?: string } }).error?.message ?? JSON.stringify(errorData);
    } catch {
      errorText = await response.text();
    }

    if (status === 429) {
      // Try to extract retry-after header
      const retryAfter = response.headers.get('retry-after');
      throw new LLMRateLimitError(
        this.name,
        retryAfter ? parseInt(retryAfter, 10) : undefined
      );
    }

    if (status >= 500) {
      throw new LLMError(
        `Provider ${this.name} server error (${status}): ${errorText}`,
        { provider: this.name, status }
      );
    }

    throw new LLMError(
      `Provider ${this.name} error (${status}): ${errorText}`,
      { provider: this.name, status }
    );
  }
}
