/**
 * Google Gemini API Adapter
 * 
 * Implements ProviderAdapter for Google's Gemini API
 * Reference: https://ai.google.dev/api/rest
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
import { formatGeminiMessages } from './gemini-message-formatter.js';
import { parseGeminiSSEStream } from './gemini-sse-parser.js';
import { parseGeminiResponse, type GeminiResponse } from './gemini-response-parser.js';

type HarmCategory =
  | 'HARM_CATEGORY_HARASSMENT'
  | 'HARM_CATEGORY_HATE_SPEECH'
  | 'HARM_CATEGORY_SEXUALLY_EXPLICIT'
  | 'HARM_CATEGORY_DANGEROUS_CONTENT'
  | 'HARM_CATEGORY_CIVIC_INTEGRITY';

type HarmThreshold =
  | 'BLOCK_NONE'
  | 'BLOCK_ONLY_HIGH'
  | 'BLOCK_MEDIUM_AND_ABOVE'
  | 'BLOCK_LOW_AND_ABOVE';

interface GeminiRequest {
  contents: ReturnType<typeof formatGeminiMessages>;
  systemInstruction?: { parts: [{ text: string }] };
  tools?: [{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }];
  generationConfig?: { maxOutputTokens?: number; temperature?: number; thinkingLevel?: number };
  safetySettings?: Array<{ category: HarmCategory; threshold: HarmThreshold }>;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name: string;
  readonly model: string;
  private readonly config: ProviderConfig;
  private readonly baseUrl: string;
  onStreamParseError?: (event: { provider: string; raw: string; error: string }) => void;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  private buildRequestBody(options: LLMCallOptions): GeminiRequest {
    const body: GeminiRequest = {
      contents: formatGeminiMessages(options.messages),
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? this.config.maxTokens,
        temperature: options.temperature ?? this.config.temperature,
      },
    };
    if (options.system) {
      body.systemInstruction = { parts: [{ text: options.system }] };
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = [{
        functionDeclarations: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      }];
    }
    return body;
  }

  async call(options: LLMCallOptions): Promise<LLMResponse> {
    const body = this.buildRequestBody(options);
    const timeout = options.timeoutMs ?? this.config.timeoutMs;
    const [abortHandle, cleanup] = withCombinedAbortSignal(options.signal, timeout);

    try {
      const model = options.model ?? this.config.model;
      const response = await fetch(
        `${this.baseUrl}/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey },
          body: JSON.stringify(body),
          signal: abortHandle.signal,
        }
      );
      if (!response.ok) await throwHttpErrorResponse(this.name, response);
      const data = await response.json() as GeminiResponse & { error?: { message: string } };
      if (data.error) throw new LLMError(`Gemini API error: ${data.error.message}`, { provider: this.name });
      return parseGeminiResponse(data);
    } catch (error) {
      const classified = classifyFetchAbortError(error, options.signal, timeout, this.name);
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

  async* stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk> {
    const body = this.buildRequestBody(options);
    const timeout = options.timeoutMs ?? this.config.timeoutMs;
    const [abortHandle, cleanup] = withCombinedAbortSignal(options.signal, timeout);

    try {
      const model = options.model ?? this.config.model;
      const response = await fetch(
        `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey },
          body: JSON.stringify(body),
          signal: abortHandle.signal,
        }
      );
      if (!response.ok) await throwHttpErrorResponse(this.name, response);
      // 进入 stream 阶段：切换 timer 为总时长保护
      abortHandle.enterStreamPhase(STREAM_MAX_DURATION_MS);
      const idleTimeoutMs = Math.min(timeout, STREAM_IDLE_MAX_MS);
      yield* parseGeminiSSEStream(response, abortHandle, idleTimeoutMs, this.name, this.onStreamParseError);
    } catch (error) {
      const classified = classifyFetchAbortError(error, options.signal, timeout, this.name);
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
