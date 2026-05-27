/**
 * OpenAI API Adapter
 *
 * Implements ProviderAdapter for OpenAI-compatible APIs
 * Supports: OpenAI, DeepSeek, Moonshot, and other OpenAI-format providers
 *
 * phase 630 (E fork r76 / 形态 A.3): SSE parser / message formatter / response parser
 * 抽 3 sub-file / 主 file 仅 ctor + call + stream + 主 class glue
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
  ProviderAdapter,
  StreamChunk,
} from './types.js';
import { STREAM_MAX_DURATION_MS, STREAM_IDLE_MAX_MS } from './constants.js';
import { withCombinedAbortSignal, classifyFetchAbortError } from './abort-helper.js';
// NEW imports（sub-file）
import { formatMessages, formatTools } from './openai-message-formatter.js';
import { parseSSEStream } from './openai-sse-parser.js';
import { parseResponse } from './openai-response-parser.js';

/**
 * OpenAI API request body
 */
interface OpenAIRequest {
  model: string;
  messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>;
  max_tokens: number;
  temperature?: number;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }>;
  stream?: boolean;
  /** OpenAI o1/o3 系列模型 reasoning effort 档位（v1 spec 3 档）*/
  reasoning_effort?: 'low' | 'medium' | 'high';
}

/**
 * OpenAI API response
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI adapter implementation
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly name: string;
  readonly model: string;

  private readonly config: ProviderConfig;
  private readonly baseUrl: string;

  onStreamParseError?: (event: { provider: string; raw: string; error: string }) => void;
  onToolArgParseError?: (event: { provider: string; toolName: string; rawArgs: string; error: string }) => void;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  /**
   * Make a single LLM call
   */
  async call(options: LLMCallOptions): Promise<LLMResponse> {
    const { messages, system, tools, maxTokens, temperature, timeoutMs, signal } = options;

    // Build request body
    const body: OpenAIRequest = {
      model: options.model ?? this.config.model,
      messages: formatMessages(messages, system),
      max_tokens: maxTokens ?? this.config.maxTokens,
    };

    if (temperature !== undefined) {
      body.temperature = temperature;
    } else if (this.config.temperature !== undefined) {
      body.temperature = this.config.temperature;
    }

    if (this.config.reasoningEffort) {
      body.reasoning_effort = this.config.reasoningEffort;
    }

    if (tools && tools.length > 0) {
      body.tools = formatTools(tools);
    }

    const timeout = timeoutMs ?? this.config.timeoutMs;
    const [abortHandle, cleanup] = withCombinedAbortSignal(signal, timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          ...this.config.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: abortHandle.signal,
      });

      if (!response.ok) {
        await throwHttpErrorResponse(this.name, response);
      }

      const data = await response.json() as OpenAIResponse;
      return parseResponse(data, this.name, this.onToolArgParseError);

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
    const { messages, system, tools, maxTokens, temperature, timeoutMs, signal } = options;

    const body: OpenAIRequest & { stream: boolean } = {
      model: options.model ?? this.config.model,
      messages: formatMessages(messages, system),
      max_tokens: maxTokens ?? this.config.maxTokens,
      stream: true,
    };

    if (temperature !== undefined) body.temperature = temperature;
    else if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (this.config.reasoningEffort) {
      body.reasoning_effort = this.config.reasoningEffort;
    }
    if (tools && tools.length > 0) {
      body.tools = formatTools(tools);
    }

    const timeout = timeoutMs ?? this.config.timeoutMs;
    const [abortHandle, cleanup] = withCombinedAbortSignal(signal, timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          ...this.config.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: abortHandle.signal,
      });

      if (!response.ok) await throwHttpErrorResponse(this.name, response);

      // 进入 stream 阶段：切换 timer 为总时长保护
      abortHandle.enterStreamPhase(STREAM_MAX_DURATION_MS);
      const idleTimeoutMs = Math.min(timeout, STREAM_IDLE_MAX_MS);
      yield* parseSSEStream(response, abortHandle, idleTimeoutMs, this.name, this.onStreamParseError);
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
