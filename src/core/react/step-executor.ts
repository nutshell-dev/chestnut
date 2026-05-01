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
import { cloneExecContext } from '../tools/context.js';

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
  onUnparseableToolUse?: (stopReason: string) => void;
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
  | { kind: 'max_tokens_tool_use'; meta: StepMeta };

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export async function executeStep(input: StepInput): Promise<StepResult> {
  const { messages, systemPrompt, llm, tools, ctx, callbacks } = input;
  const maxTokens = input.maxTokens ?? REACT_DEFAULT_MAX_TOKENS;

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  safeCallback('onBeforeLLMCall', () => callbacks?.onBeforeLLMCall?.());

  const llmStartTime = Date.now();
  const callOptions: LLMCallOptions = {
    messages, system: systemPrompt, tools, maxTokens,
    signal: ctx.signal, idleTimeoutMs: input.idleTimeoutMs,
  };
  const { response, llmInfo } = await runLLMCall(llm, callOptions, llmStartTime, callbacks);

  if (response.content.length === 0) {
    if (callbacks?.onEmptyResponse) callbacks.onEmptyResponse(response.stop_reason);
    else console.warn(`[step-executor] LLM returned empty response (stop_reason=${response.stop_reason})`);
  }

  if (response.stop_reason === 'tool_use') return handleToolUseStop(response, input, llmInfo);

  if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop') {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    return { kind: 'final', stopReason: 'end_turn', finalText: text };
  }

  if (response.stop_reason === 'max_tokens') return handleMaxTokensStop(response, input, llmInfo, maxTokens);

  if (callbacks?.onUnknownStopReason) callbacks.onUnknownStopReason(response.stop_reason);
  else console.warn(`[step-executor] Unknown stop_reason: "${response.stop_reason}", treating as end_turn`);
  const text = extractText(response.content);
  appendAssistantMessage(messages, response.content);
  return { kind: 'final', stopReason: 'unknown', finalText: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step helpers
// ─────────────────────────────────────────────────────────────────────────────

async function runLLMCall(
  llm: LLMService,
  callOptions: LLMCallOptions,
  llmStartTime: number,
  callbacks?: StepCallbacks,
): Promise<{ response: LLMResponse; llmInfo: LLMCallInfo }> {
  let response: LLMResponse;
  try {
    response = await collectStreamResponse(llm, callOptions, callbacks);
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
  return { response, llmInfo };
}

async function handleToolUseStop(
  response: LLMResponse,
  input: StepInput,
  llmInfo: LLMCallInfo,
): Promise<StepResult> {
  const { messages, executor, registry, ctx, callbacks } = input;
  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    if (callbacks?.onUnparseableToolUse) callbacks.onUnparseableToolUse(response.stop_reason);
    else console.warn(`[step-executor] LLM returned tool_use stop_reason but no parseable tool calls, treating as no_tool`);
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
  const toolCtx = ctx.signal?.aborted
    ? cloneExecContext(ctx, { signal: undefined })
    : ctx;
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

function handleMaxTokensStop(
  response: LLMResponse,
  input: StepInput,
  llmInfo: LLMCallInfo,
  maxTokens: number,
): StepResult {
  const { messages } = input;
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
  }
  const text = extractText(response.content);
  appendAssistantMessage(messages, response.content);
  return {
    kind: 'final',
    stopReason: 'max_tokens_text',
    finalText: text + '\n\n[Response truncated due to length limit]',
  };
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

interface StreamState {
  contentBlocks: ContentBlock[];
  currentText: string;
  currentThinking: string;
  currentSignature: string;
  currentToolUse: { id: string; name: string; input: string } | null;
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number } | undefined;
}

function createStreamState(): StreamState {
  return {
    contentBlocks: [],
    currentText: '',
    currentThinking: '',
    currentSignature: '',
    currentToolUse: null,
    stopReason: 'end_turn',
    usage: undefined,
  };
}

function parseToolInput(raw: string, toolName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error(`[step-executor] Failed to parse tool input for "${toolName}": ${err instanceof Error ? err.message : String(err)}`);
    return { __parseError: true, __raw: raw ?? '' };
  }
}

function flushThinking(state: StreamState): void {
  if (state.currentThinking) {
    state.contentBlocks.push({
      type: 'thinking',
      thinking: state.currentThinking,
      signature: state.currentSignature,
    });
    state.currentThinking = '';
    state.currentSignature = '';
  }
}

function flushText(state: StreamState, callbacks?: StepCallbacks): void {
  if (state.currentText) {
    state.contentBlocks.push({ type: 'text', text: state.currentText });
    state.currentText = '';
    callbacks?.onTextEnd?.();
  }
}

function flushToolUse(state: StreamState): void {
  if (state.currentToolUse) {
    state.contentBlocks.push({
      type: 'tool_use',
      id: state.currentToolUse.id,
      name: state.currentToolUse.name,
      input: parseToolInput(state.currentToolUse.input, state.currentToolUse.name),
    });
  }
}

function resetState(state: StreamState): void {
  state.contentBlocks.length = 0;
  state.currentText = '';
  state.currentThinking = '';
  state.currentSignature = '';
  state.currentToolUse = null;
  state.stopReason = 'end_turn';
  state.usage = undefined;
}

function finalizeContent(state: StreamState, callbacks?: StepCallbacks): void {
  if (state.currentThinking) {
    state.contentBlocks.push({
      type: 'thinking',
      thinking: state.currentThinking,
      signature: state.currentSignature,
    });
  }
  if (state.currentText) {
    state.contentBlocks.push({ type: 'text', text: state.currentText });
    callbacks?.onTextEnd?.();
  }
  if (state.currentToolUse) {
    state.contentBlocks.push({
      type: 'tool_use',
      id: state.currentToolUse.id,
      name: state.currentToolUse.name,
      input: parseToolInput(state.currentToolUse.input, state.currentToolUse.name),
    } as ContentBlock);
    state.currentToolUse = null;
  }
}

async function collectStreamResponse(
  llm: LLMService,
  callOptions: LLMCallOptions,
  callbacks?: StepCallbacks,
): Promise<LLMResponse> {
  const state = createStreamState();

  try {
    for await (const chunk of llm.stream(callOptions)) {
      if (callOptions.signal?.aborted) throwAbortError(callOptions.signal);
      switch (chunk.type) {
        case 'text_delta':
          flushThinking(state);
          if (chunk.delta) {
            state.currentText += chunk.delta;
            callbacks?.onTextDelta?.(chunk.delta);
          }
          break;
        case 'thinking_delta':
          if (chunk.delta) {
            state.currentThinking += chunk.delta;
            callbacks?.onThinkingDelta?.(chunk.delta);
          }
          break;
        case 'thinking_signature':
          if (chunk.signature) state.currentSignature = chunk.signature;
          break;
        case 'tool_use_start':
          flushThinking(state);
          flushText(state, callbacks);
          flushToolUse(state);
          state.currentToolUse = { id: chunk.toolUse!.id, name: chunk.toolUse!.name, input: '' };
          state.stopReason = 'tool_use';
          break;
        case 'tool_use_delta':
          if (state.currentToolUse && chunk.toolUse?.partialInput) {
            state.currentToolUse.input += chunk.toolUse.partialInput;
          }
          break;
        case 'reset':
          if (!callbacks?.onReset) console.warn(`[llm] mid-stream failover: ${chunk.provider} timed out after ${chunk.timeoutMs}ms`);
          resetState(state);
          callbacks?.onReset?.(chunk.provider ?? 'unknown', chunk.timeoutMs ?? 0);
          break;
        case 'provider_failed':
          callbacks?.onProviderFailed?.(chunk.provider ?? 'unknown', chunk.model ?? 'unknown', chunk.error ?? 'unknown error');
          break;
        case 'done':
          if (chunk.usage) {
            state.usage = { input_tokens: chunk.usage.inputTokens, output_tokens: chunk.usage.outputTokens };
          }
          if (chunk.stopReason && chunk.stopReason !== 'end_turn') state.stopReason = chunk.stopReason;
          break;
      }
    }
  } catch (err) {
    if (callOptions.signal?.aborted) {
      if (state.stopReason !== 'tool_use') throwAbortError(callOptions.signal);
      // stopReason === 'tool_use'：不 throw，fall through
    } else {
      throw err;
    }
  }

  finalizeContent(state, callbacks);

  return {
    content: state.contentBlocks,
    stop_reason: state.stopReason,
    usage: state.usage,
  };
}

interface CategorizedCalls {
  readonlyAsync: { call: ToolUseBlock; index: number }[];
  readonlySync: { call: ToolUseBlock; index: number }[];
  write: { call: ToolUseBlock; index: number }[];
}

function categorizeToolCalls(
  toolCalls: ToolUseBlock[],
  registry: ToolRegistry,
): CategorizedCalls {
  const readonlyAsync: { call: ToolUseBlock; index: number }[] = [];
  const readonlySync: { call: ToolUseBlock; index: number }[] = [];
  const write: { call: ToolUseBlock; index: number }[] = [];

  for (const [i, call] of toolCalls.entries()) {
    const tool = registry.get(call.name);
    const wantsAsync = (call.input as Record<string, unknown>)?.async === true;
    if (tool?.readonly === true && !wantsAsync) {
      readonlySync.push({ call, index: i });
    } else if (tool?.readonly === true && wantsAsync) {
      readonlyAsync.push({ call, index: i });
    } else {
      write.push({ call, index: i });
    }
  }
  return { readonlyAsync, readonlySync, write };
}

async function executeSequential(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  callbacks?: StepCallbacks,
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [];
  for (const call of toolCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
    const result = await executeSingleTool(call, executor, ctx);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
    results.push(toToolResultBlock(call.id, result));
  }
  return results;
}

async function executeReadonlyAsync(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacks?: StepCallbacks,
): Promise<void> {
  for (const { call, index } of group) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
    const result = await executeSingleTool(call, executor, ctx);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
    results.set(index, toToolResultBlock(call.id, result));
  }
}

async function executeReadonlySync(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacks?: StepCallbacks,
): Promise<void> {
  const parseErrorCalls = group.filter(
    ({ call }) => (call.input as Record<string, unknown>)?.__parseError === true
  );
  const cleanCalls = group.filter(
    ({ call }) => (call.input as Record<string, unknown>)?.__parseError !== true
  );

  for (const { call, index } of parseErrorCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
    const result = await executeSingleTool(call, executor, ctx);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
    results.set(index, toToolResultBlock(call.id, result));
  }

  if (cleanCalls.length === 0) return;

  for (const { call } of cleanCalls) {
    await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
  }

  const batch = cleanCalls.map(({ call }) => {
    const { async: _asyncMode, ...toolArgs } = call.input as Record<string, unknown>;
    return { toolName: call.name, args: toolArgs };
  });

  const parallelResults = await executor.executeParallel(batch, ctx);

  for (let i = 0; i < cleanCalls.length; i++) {
    const { call, index } = cleanCalls[i];
    const result = parallelResults[i];
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
    results.set(index, toToolResultBlock(call.id, result));
  }
}

async function executeWriteCalls(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacks?: StepCallbacks,
): Promise<void> {
  for (const { call, index } of group) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    await safeCallbackAsync('onToolCall', async () => await callbacks?.onToolCall?.(call.name, call.id));
    const result = await executeSingleTool(call, executor, ctx);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result));
    results.set(index, toToolResultBlock(call.id, result));
  }
}

async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  registry: ToolRegistry | undefined,
  callbacks?: StepCallbacks,
): Promise<ToolResultBlock[]> {
  if (!registry) return executeSequential(toolCalls, executor, ctx, callbacks);

  const { readonlyAsync, readonlySync, write } = categorizeToolCalls(toolCalls, registry);
  const results = new Map<number, ToolResultBlock>();

  await executeReadonlyAsync(readonlyAsync, executor, ctx, results, callbacks);
  await executeReadonlySync(readonlySync, executor, ctx, results, callbacks);
  await executeWriteCalls(write, executor, ctx, results, callbacks);

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
