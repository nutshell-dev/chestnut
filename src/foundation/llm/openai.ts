/**
 * OpenAI API Adapter
 * 
 * Implements ProviderAdapter for OpenAI-compatible APIs
 * Supports: OpenAI, DeepSeek, Moonshot, and other OpenAI-format providers
 */

import type {
  LLMResponse,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
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

/**
 * Decode HTML entities in tool call arguments (xAI/grok sometimes HTML-encodes JSON)
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

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
      messages: this.formatMessages(messages, system),
      max_tokens: maxTokens ?? this.config.maxTokens,
    };
    
    if (temperature !== undefined) {
      body.temperature = temperature;
    } else if (this.config.temperature !== undefined) {
      body.temperature = this.config.temperature;
    }
    
    if (this.config.reasoningEffort) {
      (body as unknown as Record<string, unknown>).reasoning_effort = this.config.reasoningEffort;
    }
    
    if (tools && tools.length > 0) {
      body.tools = this.formatTools(tools);
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
        await this.handleErrorResponse(response);
      }
      
      const data = await response.json() as OpenAIResponse;
      return this.parseResponse(data);
      
    } catch (error) {
      const classified = classifyFetchAbortError(error, signal, timeout, this.name);
      if (classified) throw classified;
      
      if (error instanceof LLMError) {
        throw error;
      }
      
      throw new LLMError(
        `LLM call failed: ${(error as Error).message}`,
        { provider: this.name }
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
      messages: this.formatMessages(messages, system),
      max_tokens: maxTokens ?? this.config.maxTokens,
      stream: true,
    };

    if (temperature !== undefined) body.temperature = temperature;
    else if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (this.config.reasoningEffort) {
      (body as unknown as Record<string, unknown>).reasoning_effort = this.config.reasoningEffort;
    }
    if (tools && tools.length > 0) {
      body.tools = this.formatTools(tools);
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

      if (!response.ok) await this.handleErrorResponse(response);

      // 进入 stream 阶段：切换 timer 为总时长保护
      abortHandle.enterStreamPhase(STREAM_MAX_DURATION_MS);
      yield* this.parseSSEStream(response, abortHandle, timeout);
    } catch (error) {
      const classified = classifyFetchAbortError(error, signal, timeout, this.name);
      if (classified) throw classified;
      if (error instanceof LLMError) throw error;
      throw new LLMError(`LLM stream failed: ${(error as Error).message}`, { provider: this.name });
    } finally {
      cleanup();
    }
  }

  /**
   * Parse OpenAI SSE stream
   */
  private async* parseSSEStream(
    response: Response,
    handle: CombinedAbortHandle,
    idleTimeoutMs: number,
  ): AsyncIterableIterator<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer = setTimeout(() => handle.abort(), idleTimeoutMs);
    
    // Track tool calls across chunks (index -> partial data)
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string; started: boolean }>();
    
    // Track finish_reason and usage for final done chunk
    let lastFinishReason: string | undefined;
    let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

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
          if (!data || data === '[DONE]') {
            if (data === '[DONE]') {
              const stopReason =
                lastFinishReason === 'tool_calls' ? 'tool_use' :
                lastFinishReason === 'length'     ? 'max_tokens' :
                lastFinishReason === 'stop'       ? 'end_turn' :
                lastFinishReason ?? 'end_turn';
              yield {
                type: 'done',
                stopReason,
                usage: lastUsage ? {
                  inputTokens: lastUsage.prompt_tokens ?? 0,
                  outputTokens: lastUsage.completion_tokens ?? 0,
                } : undefined,
              };
            }
            continue;
          }

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data);
          } catch (err) {
            console.warn(`[openai] Failed to parse SSE event, skipping. data="${data.slice(0, 100)}" err=${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          // SSE-level error event (no choices, top-level error object)
          const sseError = event.error as Record<string, unknown> | undefined;
          if (sseError && !event.choices) {
            const errorType = sseError.type as string ?? 'unknown_error';
            const errorMsg = sseError.message as string ?? JSON.stringify(event);
            const errorCode = sseError.code as string | undefined;
            if (errorCode === '429' || errorType === 'rate_limit_error') {
              throw new LLMRateLimitError(this.name);
            }
            throw new LLMError(
              `${errorType}: ${errorMsg}`,
              { provider: this.name }
            );
          }

          // Track finish_reason and usage from event
          const choice = (event.choices as Array<Record<string, unknown>>)?.[0];
          const finishReason = choice?.finish_reason as string | undefined;
          if (finishReason) lastFinishReason = finishReason;

          const usage = event.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
          if (usage?.prompt_tokens !== undefined) lastUsage = usage;

          const delta = choice?.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: 'text_delta', delta: String(delta.content) };
          }
          
          // DeepSeek Reasoner thinking
          if (delta.reasoning_content) {
            yield { type: 'thinking_delta', delta: String(delta.reasoning_content) };
          }
          
          // OpenAI o-series reasoning (delta.reasoning)
          if (delta.reasoning) {
            yield { type: 'thinking_delta', delta: String(delta.reasoning) };
          }

          // Tool calls
          const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const index = tc.index as number;
              const func = tc.function as Record<string, unknown> | undefined;
              
              if (!toolCallBuffers.has(index)) {
                // New tool call
                toolCallBuffers.set(index, {
                  id: tc.id as string || '',
                  name: func?.name as string || '',
                  arguments: func?.arguments as string || '',
                  started: false,
                });
              } else {
                // Existing tool call - accumulate arguments
                const buf = toolCallBuffers.get(index)!;
                if (tc.id) buf.id = tc.id as string;
                if (func?.name) buf.name = func.name as string;
                if (func?.arguments) buf.arguments += func.arguments as string;
              }

              const buf = toolCallBuffers.get(index)!;

              // Emit tool_use_start only when both id and name are available
              if (!buf.started && buf.id && buf.name) {
                buf.started = true;
                yield {
                  type: 'tool_use_start',
                  toolUse: { id: buf.id, name: buf.name, partialInput: '' },
                };
              }

              // Emit tool_use_delta for accumulated arguments
              if (func?.arguments && buf.started) {
                yield {
                  type: 'tool_use_delta',
                  toolUse: { id: buf.id, name: buf.name, partialInput: func.arguments as string },
                };
              }
            }
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
   * Format messages for OpenAI API
   * - system 提取为第一条消息
   * - tool_result 转换为 role: tool
   */
  private formatMessages(
    messages: Array<{ role: string; content: unknown }>,
    system?: string
  ): Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> {
    const result: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];
    
    // System message as first message
    if (system) {
      result.push({ role: 'system', content: system });
    }
    
    for (const m of messages) {
      const role = m.role;
      
      // Handle array content (tool_use, tool_result blocks)
      if (Array.isArray(m.content)) {
        const blocks = m.content as Array<Record<string, unknown>>;
        
        // Check for tool_use blocks (assistant)
        if (role === 'assistant') {
          const toolUses = blocks.filter(b => b.type === 'tool_use');
          if (toolUses.length > 0) {
            const textBlocks = blocks.filter(b => b.type === 'text') as Array<{text?: string}>;
            const text = textBlocks.map(b => b.text || '').join('');
            
            result.push({
              role: 'assistant',
              content: text || '',
              tool_calls: toolUses.map(tu => ({
                id: tu.id as string,
                type: 'function',
                function: {
                  name: tu.name as string,
                  arguments: JSON.stringify(tu.input || {}),
                },
              })),
            });
            continue;
          }
        }
        
        // Check for tool_result blocks (user/tool)
        const toolResults = blocks.filter(b => b.type === 'tool_result');
        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            tool_call_id: tr.tool_use_id as string,
          });
        }
        
        // Regular text blocks
        const textBlocks = blocks.filter(b => b.type === 'text') as Array<{text?: string}>;
        const text = textBlocks.map(b => b.text || '').join('');
        if (text || toolResults.length === 0) {
          result.push({ role: role === 'assistant' ? 'assistant' : 'user', content: text || '' });
        }
      } else {
        // String content
        result.push({ 
          role: role === 'assistant' ? 'assistant' : 'user', 
          content: m.content as string 
        });
      }
    }
    
    return result;
  }
  
  /**
   * Format tools for OpenAI API
   */
  private formatTools(tools: Array<{ name: string; description: string; input_schema: unknown }>): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }> {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }
  
  /**
   * Parse OpenAI response to our LLMResponse format
   */
  private parseResponse(data: OpenAIResponse): LLMResponse {
    const choice = data.choices[0];
    const message = choice?.message;
    const content: ContentBlock[] = [];
    
    // OpenAI o-series reasoning content
    if (message?.reasoning_content) {
      content.push({ type: 'thinking', thinking: message.reasoning_content } as ContentBlock);
    }
    
    // Text content
    if (message?.content) {
      content.push({ type: 'text', text: message.content });
    }
    
    // Tool calls
    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        try {
          const input = JSON.parse(decodeHtmlEntities(tc.function.arguments));
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        } catch {
          // Invalid JSON, treat as string
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: decodeHtmlEntities(tc.function.arguments),
          });
        }
      }
    }
    
    // Normalize stop_reason to internal format
    const finishReason = choice?.finish_reason ?? 'stop';
    const stopReason =
      finishReason === 'tool_calls' ? 'tool_use' :
      finishReason === 'length'     ? 'max_tokens' :
      finishReason === 'stop'       ? 'end_turn' :
      finishReason;
    
    return {
      content,
      stop_reason: stopReason,
      usage: data.usage ? {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
      } : undefined,
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
