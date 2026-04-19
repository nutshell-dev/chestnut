/**
 * Google Gemini API Adapter
 * 
 * Implements ProviderAdapter for Google's Gemini API
 * Reference: https://ai.google.dev/api/rest
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
  ProviderAdapter,
  StreamChunk,
} from './types.js';
import { STREAM_MAX_DURATION_MS } from '../../constants.js';
import { withCombinedAbortSignal, type CombinedAbortHandle, classifyFetchAbortError } from './abort-helper.js';

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

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
  contents: GeminiContent[];
  systemInstruction?: { parts: [{ text: string }] };
  tools?: [{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }];
  generationConfig?: { maxOutputTokens?: number; temperature?: number; thinkingLevel?: number };
  safetySettings?: Array<{ category: HarmCategory; threshold: HarmThreshold }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: GeminiContent;
    finishReason: string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name: string;
  readonly model: string;
  private readonly config: ProviderConfig;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  private buildRequestBody(options: LLMCallOptions): GeminiRequest {
    const body: GeminiRequest = {
      contents: this.formatMessages(options.messages),
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

  private formatMessages(messages: Array<{ role: string; content: unknown }>): GeminiContent[] {
    // Build tool_use_id -> name mapping (Gemini functionResponse needs name, not id)
    const idToName = new Map<string, string>();
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b.type === 'tool_use') {
            idToName.set(b.id as string, b.name as string);
          }
        }
      }
    }

    const result: GeminiContent[] = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts: GeminiPart[] = [];

      if (!Array.isArray(m.content)) {
        parts.push({ text: m.content as string });
      } else {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b.type === 'text') {
            parts.push({ text: b.text as string });
          } else if (b.type === 'tool_use') {
            parts.push({ functionCall: { name: b.name as string, args: (b.input ?? {}) as Record<string, unknown> } });
          } else if (b.type === 'tool_result') {
            const name = idToName.get(b.tool_use_id as string) ?? (b.tool_use_id as string);
            const response: Record<string, unknown> = typeof b.content === 'string'
              ? { output: b.content }
              : (b.content as Record<string, unknown>) ?? {};
            parts.push({ functionResponse: { name, response } });
          }
        }
      }

      if (parts.length > 0) {
        result.push({ role, parts });
      }
    }
    return result;
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
      if (!response.ok) await this.handleErrorResponse(response);
      const data = await response.json() as GeminiResponse;
      return this.parseResponse(data);
    } catch (error) {
      const classified = classifyFetchAbortError(error, options.signal, timeout, this.name);
      if (classified) throw classified;
      if (error instanceof LLMError) throw error;
      throw new LLMError(`LLM call failed: ${(error as Error).message}`, { provider: this.name });
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
      if (!response.ok) await this.handleErrorResponse(response);
      // 进入 stream 阶段：切换 timer 为总时长保护
      abortHandle.enterStreamPhase(STREAM_MAX_DURATION_MS);
      yield* this.parseSSEStream(response, abortHandle, timeout);
    } catch (error) {
      const classified = classifyFetchAbortError(error, options.signal, timeout, this.name);
      if (classified) throw classified;
      if (error instanceof LLMError) throw error;
      throw new LLMError(`LLM stream failed: ${(error as Error).message}`, { provider: this.name });
    } finally {
      cleanup();
    }
  }

  private async* parseSSEStream(
    response: Response,
    handle: CombinedAbortHandle,
    idleTimeoutMs: number,
  ): AsyncIterableIterator<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer = setTimeout(() => handle.abort(), idleTimeoutMs);
    let fcIndex = 0;
    let lastUsage: { promptTokenCount: number; candidatesTokenCount: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        clearTimeout(idleTimer);
        if (done) break;
        idleTimer = setTimeout(() => handle.abort(), idleTimeoutMs);

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          let event: GeminiResponse & { error?: { code?: number; message?: string; status?: string } };
          try { event = JSON.parse(data); } catch { continue; }

          // SSE-level error (no candidates, top-level error object)
          if (event.error && !event.candidates) {
            const { code, message, status } = event.error;
            if (code === 429) {
              throw new LLMRateLimitError(this.name);
            }
            throw new LLMError(
              `${status ?? 'error'}: ${message ?? JSON.stringify(event.error)}`,
              { provider: this.name }
            );
          }

          const candidate = event.candidates?.[0];
          if (!candidate) continue;

          for (const part of candidate.content?.parts ?? []) {
            if ('text' in part) {
              yield { type: 'text_delta', delta: part.text };
            } else if ('functionCall' in part) {
              const { name, args } = part.functionCall;
              const id = `gemini-${name}-${fcIndex}`;
              yield { type: 'tool_use_start', toolUse: { id, name, partialInput: '' } };
              yield { type: 'tool_use_delta', toolUse: { id, name, partialInput: JSON.stringify(args) } };
              fcIndex++;
            }
          }

          // Track usage metadata across events
          if (event.usageMetadata) {
            lastUsage = event.usageMetadata;
          }

          // Yield done chunk when finishReason is available (decoupled from usageMetadata)
          if (candidate.finishReason) {
            const stopReason =
              candidate.finishReason === 'STOP'       ? 'end_turn' :
              candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' :
              candidate.finishReason === 'SAFETY'     ? 'content_filter' :
              candidate.finishReason.toLowerCase();

            yield {
              type: 'done',
              stopReason,
              usage: lastUsage ? {
                inputTokens: lastUsage.promptTokenCount,
                outputTokens: lastUsage.candidatesTokenCount,
              } : undefined,
            };
          }
        }
      }
    } finally {
      clearTimeout(idleTimer);
      try { reader.releaseLock(); } catch {}
    }
  }

  private parseResponse(data: GeminiResponse): LLMResponse {
    const candidate = data.candidates?.[0];

    // Content filtered or generation failed
    if (!candidate?.content?.parts) {
      const reason = candidate?.finishReason ?? 'UNKNOWN';
      return {
        content: [{ type: 'text', text: '' }],
        stop_reason: reason === 'SAFETY' ? 'content_filter' : 'end_turn',
        usage: data.usageMetadata ? {
          input_tokens: data.usageMetadata.promptTokenCount,
          output_tokens: data.usageMetadata.candidatesTokenCount,
        } : undefined,
      };
    }

    const content: ContentBlock[] = [];
    let fcIndex = 0;

    for (const part of candidate.content.parts) {
      if ('text' in part) {
        content.push({ type: 'text', text: part.text });
      } else if ('functionCall' in part) {
        const { name, args } = part.functionCall;
        content.push({ type: 'tool_use', id: `gemini-${name}-${fcIndex++}`, name, input: args });
      }
    }

    const finishReason = candidate.finishReason ?? 'STOP';
    const hasToolUse = content.some(b => b.type === 'tool_use');
    const stopReason =
      hasToolUse                      ? 'tool_use' :
      finishReason === 'MAX_TOKENS'   ? 'max_tokens' :
      finishReason === 'SAFETY'       ? 'content_filter' :
      'end_turn';
    return {
      content,
      stop_reason: stopReason,
      usage: data.usageMetadata ? {
        input_tokens: data.usageMetadata.promptTokenCount,
        output_tokens: data.usageMetadata.candidatesTokenCount,
      } : undefined,
    };
  }

  private async handleErrorResponse(response: Response): Promise<void> {
    const status = response.status;
    let errorText: string;

    try {
      const errorData = await response.json() as { error?: { message?: string; status?: string } };
      // Gemini error format: { error: { code, message, status } }
      errorText = errorData.error?.message ?? JSON.stringify(errorData);
    } catch {
      errorText = await response.text();
    }

    if (status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new LLMRateLimitError(
        this.name,
        retryAfter ? parseInt(retryAfter, 10) : undefined
      );
    }
    if (status >= 500) {
      throw new LLMError(`Server error (${status}): ${errorText}`, { provider: this.name });
    }
    throw new LLMError(`Request failed (${status}): ${errorText}`, { provider: this.name });
  }
}
