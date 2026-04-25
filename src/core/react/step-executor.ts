/**
 * Step Executor - Single-step LLM call + tool execution
 *
 * Extracted from loop.ts. Executes one LLM turn:
 * 1. Stream LLM response
 * 2. If tool_use: execute tools, append results, return continue
 * 3. If end_turn: return final
 * 4. Handle max_tokens truncation (text or tool_use)
 * 5. Handle context window exceeded
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock, LLMResponse, ToolDefinition } from '../../types/message.js';
import type { LLMService, LLMCallOptions } from '../../foundation/llm/index.js';
import type { StreamChunk } from '../../foundation/llm/types.js';
import type { IToolExecutor, ExecContext, ToolResult, ToolRegistry } from '../tools/executor.js';
import { REACT_DEFAULT_MAX_TOKENS } from '../../constants.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../types/signals.js';
import { throwAbortError } from './abort-helpers.js';

export interface LLMCallInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
}

export interface StepCallbacks {
  onBeforeLLMCall?: () => void;
  onLLMResult?: (info: LLMCallInfo) => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: string) => void | Promise<void>;
  onToolResult?: (toolName: string, toolUseId: string, result: ToolResult) => void;
  onReset?: (provider: string, timeoutMs: number) => void;
  onProviderFailed?: (provider: string, model: string, error: string) => void;
  onEmptyResponse?: (stopReason: string) => void;
  onUnknownStopReason?: (stopReason: string) => void;
}

export interface StepInput {
  messages: Message[];
  systemPrompt: string;
  llm: LLMService;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;
  ctx: ExecContext;
  maxTokens?: number;
  idleTimeoutMs?: number;
  callbacks?: StepCallbacks;
}

export interface StepMeta {
  toolCallCount: number;
  parseErrorCount: number;
  allParseErrors: boolean;
  llm: LLMCallInfo;
}

export type StepResult =
  | { kind: 'final'; stopReason: 'end_turn' | 'max_tokens_text' | 'no_tool' | 'unknown'; finalText: string }
  | { kind: 'continue'; meta: StepMeta }
  | { kind: 'max_tokens_tool_use'; meta: StepMeta }
  | { kind: 'context_window_exceeded' };

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export async function executeStep(input: StepInput): Promise<StepResult> {
  const { messages, systemPrompt, llm, tools, executor, registry, ctx, callbacks } = input;
  const maxTokens = input.maxTokens ?? REACT_DEFAULT_MAX_TOKENS;

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  safeCallback('onBeforeLLMCall', () => callbacks?.onBeforeLLMCall?.());

  const llmStartTime = Date.now();
  let response: LLMResponse;
  try {
    response = await collectStreamResponse(
      llm,
      {
        messages,
        system: systemPrompt,
        tools,
        maxTokens,
        signal: ctx.signal,
        idleTimeoutMs: input.idleTimeoutMs,
      },
      callbacks,
    );
  } catch (err) {
    const info: LLMCallInfo = {
      model: llm.getProviderInfo?.().model ?? 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - llmStartTime,
      error: err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null
            ? JSON.stringify(err, Object.getOwnPropertyNames(err))
            : String(err)),
    };
    callbacks?.onLLMResult?.(info);
    throw err;
  }

  const llmInfo: LLMCallInfo = {
    model: llm.getProviderInfo?.().model ?? 'unknown',
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    latencyMs: Date.now() - llmStartTime,
  };
  callbacks?.onLLMResult?.(llmInfo);

  if (response.content.length === 0) {
    if (callbacks?.onEmptyResponse) {
      callbacks.onEmptyResponse(response.stop_reason);
    } else {
      console.warn(`[step-executor] LLM returned empty response (stop_reason=${response.stop_reason})`);
    }
  }

  // ── tool_use ──
  if (response.stop_reason === 'tool_use') {
    const toolCalls = extractToolCalls(response.content);
    if (toolCalls.length === 0) {
      const text = extractText(response.content);
      appendAssistantMessage(messages, response.content);
      return { kind: 'final', stopReason: 'no_tool', finalText: text };
    }
    appendAssistantMessage(messages, response.content);

    let parseErrorCount = 0;
    const trackingCallbacks: StepCallbacks = {
      ...callbacks,
      onToolResult: (name, id, result) => {
        if (result.metadata?.parseError === true) parseErrorCount++;
        callbacks?.onToolResult?.(name, id, result);
      },
    };
    // B.idle-abort: signal 已 abort 但 tool_use 已完整收集时，先让工具执行完
    const toolCtx = ctx.signal?.aborted ? { ...ctx, signal: undefined } : ctx;
    const toolResults = await executeToolCalls(toolCalls, executor, toolCtx, registry, trackingCallbacks);

    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    appendToolResults(messages, toolResults);

    return {
      kind: 'continue',
      meta: {
        toolCallCount: toolCalls.length,
        parseErrorCount,
        allParseErrors: toolCalls.length > 0 && parseErrorCount === toolCalls.length,
        llm: llmInfo,
      },
    };
  }

  // ── end_turn / stop ──
  if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop') {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    return { kind: 'final', stopReason: 'end_turn', finalText: text };
  }

  // ── max_tokens ──
  if (response.stop_reason === 'max_tokens') {
    const toolCalls = extractToolCalls(response.content);
    if (toolCalls.length > 0) {
      appendAssistantMessage(messages, response.content);
      const truncatedResults: ToolResultBlock[] = toolCalls.map(tc => ({
        type: 'tool_result' as const,
        tool_use_id: tc.id,
        content: `[TRUNCATED] 输出超过单次 token 上限（${maxTokens} tokens），工具调用被截断未执行。请将内容拆分为多次较小的调用。`,
        is_error: true,
      }));
      appendToolResults(messages, truncatedResults);
      return {
        kind: 'max_tokens_tool_use',
        meta: {
          toolCallCount: toolCalls.length,
          parseErrorCount: 0,
          allParseErrors: false,
          llm: llmInfo,
        },
      };
    } else {
      const text = extractText(response.content);
      appendAssistantMessage(messages, response.content);
      return {
        kind: 'final',
        stopReason: 'max_tokens_text',
        finalText: text + '\n\n[Response truncated due to length limit]',
      };
    }
  }

  // ── context window exceeded ──
  if (response.stop_reason === 'model_context_window_exceeded' || response.stop_reason === 'context_length_exceeded') {
    // 保留 thinking/text（运行中对用户可见的产出），丢弃 tool_use（孤儿意图——
    // 此分支不会执行工具，保留会产生无 tool_result 配对的 assistant 消息，
    // 下次 resume 时会被 provider API 拒绝）。
    const preserved = response.content.filter(
      (b) => b.type === 'thinking' || b.type === 'text'
    );
    if (preserved.length > 0) {
      appendAssistantMessage(messages, preserved);
    }
    return { kind: 'context_window_exceeded' };
  }

  // ── unknown ──
  if (callbacks?.onUnknownStopReason) {
    callbacks.onUnknownStopReason(response.stop_reason);
  } else {
    console.warn(`[step-executor] Unknown stop_reason: "${response.stop_reason}", treating as end_turn`);
  }
  const text = extractText(response.content);
  appendAssistantMessage(messages, response.content);
  return { kind: 'final', stopReason: 'unknown', finalText: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (moved from loop.ts, kept identical)
// ─────────────────────────────────────────────────────────────────────────────

function safeCallback(label: string, fn: () => void): void {
  try { fn(); }
  catch (err) { console.warn(`[step-executor] ${label} error:`, err instanceof Error ? err.message : String(err)); }
}

async function safeCallbackAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (err) { console.warn(`[step-executor] ${label} error:`, err instanceof Error ? err.message : String(err)); }
}

async function collectStreamResponse(
  llm: LLMService,
  callOptions: LLMCallOptions,
  callbacks?: StepCallbacks,
): Promise<LLMResponse> {
  const contentBlocks: ContentBlock[] = [];
  let currentText = '';
  let currentThinking = '';
  let currentSignature = '';
  let currentToolUse: { id: string; name: string; input: string } | null = null;
  let stopReason = 'end_turn';
  let usage: { input_tokens: number; output_tokens: number } | undefined;

  function parseToolInput(raw: string, toolName: string): Record<string, unknown> {
    try {
      return JSON.parse(raw || '{}');
    } catch (err) {
      console.error(`[step-executor] Failed to parse tool input for "${toolName}": ${err instanceof Error ? err.message : String(err)}`);
      return { __parseError: true, __raw: raw ?? '' };
    }
  }

  try {
    for await (const chunk of llm.stream(callOptions)) {
      // 每个 chunk 后检查 signal，确保及时响应 abort
      if (callOptions.signal?.aborted) {
        throwAbortError(callOptions.signal);
      }
      switch (chunk.type) {
        case 'text_delta':
          // Flush thinking before text starts
          if (currentThinking) {
            contentBlocks.push({ type: 'thinking', thinking: currentThinking, signature: currentSignature });
            currentThinking = '';
            currentSignature = '';
          }
          if (chunk.delta) {
            currentText += chunk.delta;
            callbacks?.onTextDelta?.(chunk.delta);
          }
          break;

        case 'thinking_delta':
          if (chunk.delta) {
            currentThinking += chunk.delta;
            callbacks?.onThinkingDelta?.(chunk.delta);
          }
          break;

        case 'thinking_signature':
          if (chunk.signature) {
            currentSignature = chunk.signature;
          }
          break;

        case 'tool_use_start':
          // Flush thinking before tool_use
          if (currentThinking) {
            contentBlocks.push({ type: 'thinking', thinking: currentThinking, signature: currentSignature });
            currentThinking = '';
            currentSignature = '';
          }
          // 保存之前的 text block
          if (currentText) {
            contentBlocks.push({ type: 'text', text: currentText });
            currentText = '';
            callbacks?.onTextEnd?.();
          }
          // 保存之前的 tool_use（如果有多个）
          if (currentToolUse) {
            contentBlocks.push({
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: parseToolInput(currentToolUse.input, currentToolUse.name),
            });
          }
          currentToolUse = {
            id: chunk.toolUse!.id,
            name: chunk.toolUse!.name,
            input: '',
          };
          stopReason = 'tool_use';
          break;

        case 'tool_use_delta':
          if (currentToolUse && chunk.toolUse?.partialInput) {
            currentToolUse.input += chunk.toolUse.partialInput;
          }
          break;

        case 'reset':
          // Mid-stream provider failover: discard partial state, new provider will start fresh
          console.warn(`[llm] mid-stream failover: ${chunk.provider} timed out after ${chunk.timeoutMs}ms`);
          contentBlocks.length = 0;
          currentText = '';
          currentThinking = '';
          currentSignature = '';
          currentToolUse = null;
          stopReason = 'end_turn';
          usage = undefined;
          callbacks?.onReset?.(chunk.provider ?? 'unknown', chunk.timeoutMs ?? 0);
          break;

        case 'provider_failed':
          callbacks?.onProviderFailed?.(chunk.provider ?? 'unknown', chunk.model ?? 'unknown', chunk.error ?? 'unknown error');
          break;

        case 'done':
          if (chunk.usage) {
            usage = {
              input_tokens: chunk.usage.inputTokens,
              output_tokens: chunk.usage.outputTokens,
            };
          }
          if (chunk.stopReason && chunk.stopReason !== 'end_turn') {
            stopReason = chunk.stopReason;
          }
          break;
      }
    }
  } catch (err) {
    if (callOptions.signal?.aborted) {
      // B.idle-abort 修复：tool_use 已开始收集时不在此处 abort，
      // fall through 到 "保存最后的 blocks" 节，由 executeStep L145 在工具执行后 abort。
      if (stopReason !== 'tool_use') {
        throwAbortError(callOptions.signal);
      }
      // stopReason === 'tool_use'：不 throw，fall through
    } else {
      throw err;
    }
  }

  // 保存最后的 blocks
  if (currentThinking) {
    contentBlocks.push({ type: 'thinking', thinking: currentThinking, signature: currentSignature });
  }
  if (currentText) {
    contentBlocks.push({ type: 'text', text: currentText });
    callbacks?.onTextEnd?.();
  }
  if (currentToolUse) {
    contentBlocks.push({
      type: 'tool_use',
      id: currentToolUse.id,
      name: currentToolUse.name,
      input: parseToolInput(currentToolUse.input, currentToolUse.name),
    } as ContentBlock);
    currentToolUse = null;
  }

  return {
    content: contentBlocks,
    stop_reason: stopReason,
    usage,
  };
}

async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  registry: ToolRegistry | undefined,
  callbacks?: StepCallbacks,
): Promise<ToolResultBlock[]> {
  // If no registry, fall back to sequential execution
  if (!registry) {
    const toolResults: ToolResultBlock[] = [];
    for (const toolCall of toolCalls) {
      if (ctx.signal?.aborted) throwAbortError(ctx.signal);
      await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(toolCall.name, toolCall.id));
      const result = await executeSingleTool(toolCall, executor, ctx);
      safeCallback('onToolResult', () => callbacks?.onToolResult?.(toolCall.name, toolCall.id, result));
      toolResults.push(toToolResultBlock(toolCall.id, result));
    }
    return toolResults;
  }

  // Group tool calls into three categories:
  // 1. Readonly + async:true → executeSingleTool (preserves async routing)
  // 2. Readonly + sync → executeParallel (parallel optimization)
  // 3. Write → executeSingleTool (sequential, for safety)
  const readonlyAsyncCalls: { call: ToolUseBlock; index: number }[] = [];
  const readonlySyncCalls: { call: ToolUseBlock; index: number }[] = [];
  const writeCalls: { call: ToolUseBlock; index: number }[] = [];

  for (const [i, call] of toolCalls.entries()) {
    const tool = registry.get(call.name);
    const wantsAsync = (call.input as Record<string, unknown>)?.async === true;
    if (tool?.readonly === true && !wantsAsync) {
      readonlySyncCalls.push({ call, index: i });
    } else if (tool?.readonly === true && wantsAsync) {
      readonlyAsyncCalls.push({ call, index: i });
    } else {
      writeCalls.push({ call, index: i });
    }
  }

  // Results map: index -> ToolResultBlock
  const results = new Map<number, ToolResultBlock>();

  // Execute readonly + async tools sequentially (preserve async routing)
  for (const { call, index } of readonlyAsyncCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
    const result = await executeSingleTool(call, executor, ctx);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
    results.set(index, toToolResultBlock(call.id, result));
  }

  // Execute readonly sync tools in parallel
  if (readonlySyncCalls.length > 0) {
    // Split: __parseError calls must NOT reach executeParallel (would leak
    // __parseError/__raw into tool args, and parseError flag would be lost).
    const parseErrorCalls = readonlySyncCalls.filter(
      ({ call }) => (call.input as Record<string, unknown>)?.__parseError === true
    );
    const cleanCalls = readonlySyncCalls.filter(
      ({ call }) => (call.input as Record<string, unknown>)?.__parseError !== true
    );

    // Handle parseError calls via executeSingleTool (symmetric with sequential branch)
    for (const { call, index } of parseErrorCalls) {
      if (ctx.signal?.aborted) throwAbortError(ctx.signal);
      await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
      const result = await executeSingleTool(call, executor, ctx);
      safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
      results.set(index, toToolResultBlock(call.id, result));
    }

    // Clean calls go through parallel path
    if (cleanCalls.length > 0) {
      for (const { call } of cleanCalls) {
        await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
      }

      const batch = cleanCalls.map(({ call }) => {
        const { async: _asyncMode, ...toolArgs } = call.input as Record<string, unknown>;
        return {
          toolName: call.name,
          args: toolArgs,
        };
      });

      const parallelResults = await executor.executeParallel(batch, ctx);

      for (let i = 0; i < cleanCalls.length; i++) {
        const { call, index } = cleanCalls[i];
        const result = parallelResults[i];
        safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
        results.set(index, toToolResultBlock(call.id, result));
      }
    }
  }

  // Execute write tools sequentially
  for (const { call, index } of writeCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
    const result = await executeSingleTool(call, executor, ctx);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
    results.set(index, toToolResultBlock(call.id, result));
  }

  // Assemble results in original order
  return toolCalls.map((_, i) => {
    const r = results.get(i);
    if (!r) throw new Error(`[step-executor] Missing result for tool call at index ${i}`);
    return r;
  });
}

async function executeSingleTool(
  toolCall: ToolUseBlock,
  executor: IToolExecutor,
  ctx: ExecContext,
): Promise<ToolResult> {
  try {
    // Extract async flag (meta parameter, not passed to tool)
    const { async: asyncMode, __parseError, __raw, ...toolArgs } = toolCall.input as Record<string, unknown>;

    // Input JSON failed to parse — return error immediately without calling the tool
    if (__parseError) {
      return {
        success: false,
        content: `工具输入 JSON 解析失败，无法调用工具 "${toolCall.name}"。原始输入: ${String(__raw || '')}`,
        metadata: { parseError: true },
      };
    }

    return await executor.execute({
      toolName: toolCall.name,
      args: toolArgs,
      ctx,
      async: asyncMode === true,
      toolUseId: toolCall.id,
    });
  } catch (err) {
    const errorType = err instanceof Error ? err.constructor.name : 'Error';
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[step-executor] Tool ${toolCall.name} execution failed:`, errorMsg);
    return {
      success: false,
      content: `[${errorType}] 工具执行失败: ${errorMsg}`,
    };
  }
}

function toToolResultBlock(toolUseId: string, result: ToolResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: result.content,
    is_error: !result.success,
  };
}

function extractToolCalls(content: ContentBlock[]): ToolUseBlock[] {
  return content
    .filter((block): block is ToolUseBlock => block.type === 'tool_use')
    .map(block => ({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    }));
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text'
    )
    .map(block => block.text)
    .join('')
    .trim();
}

function appendAssistantMessage(messages: Message[], content: ContentBlock[]): void {
  messages.push({
    role: 'assistant',
    content,
  });
}

function appendToolResults(messages: Message[], results: ToolResultBlock[]): void {
  messages.push({
    role: 'user',
    content: results,
  });
}
