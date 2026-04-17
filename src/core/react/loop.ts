/**
 * ReAct Loop - Core reasoning and action loop
 * 
 * Implements the ReAct pattern:
 * 1. Send conversation to LLM
 * 2. LLM either returns final answer or requests tool calls
 * 3. If tool calls: execute tools, append results, repeat
 * 4. If final answer: return to user
 * 
 * Reference: Python MVP clawforum/core/react_loop.py
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock, LLMResponse, ToolDefinition } from '../../types/message.js';
import type { ILLMService, LLMCallOptions } from '../../foundation/llm/index.js';
import type { StreamChunk } from '../../foundation/llm/types.js';
import type { IToolExecutor, ExecContext, ToolResult, ToolRegistry } from '../tools/executor.js';
import { MaxStepsExceededError } from '../../types/errors.js';
import { REACT_DEFAULT_MAX_TOKENS, MAX_CONSECUTIVE_PARSE_ERRORS, MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE } from '../../constants.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../types/signals.js';

function throwAbortError(signal: AbortSignal): never {
  const r = signal.reason as { type?: string; ms?: number } | undefined;
  if (r?.type === 'idle_timeout') throw new IdleTimeoutSignal(r.ms ?? 0);
  if (r?.type === 'step_yield')   throw new PriorityInboxInterrupt();
  if (r?.type === 'user')         throw new UserInterrupt();
  throw new Error(`Execution aborted (unexpected reason: ${JSON.stringify(r)})`);
}

/**
 * Safe callback wrappers - prevent UI callback errors from breaking the loop
 */
function safeCallback(label: string, fn: () => void): void {
  try { fn(); }
  catch (err) { console.warn(`[loop] ${label} error:`, err instanceof Error ? err.message : String(err)); }
}
async function safeCallbackAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (err) { console.warn(`[loop] ${label} error:`, err instanceof Error ? err.message : String(err)); }
}

/**
 * Options for runReact
 */
export interface ReactOptions {
  /** Conversation history (modified in-place) */
  messages: Message[];
  
  /** System prompt */
  systemPrompt: string;
  
  /** LLM service */
  llm: ILLMService;
  
  /** Tool executor */
  executor: IToolExecutor;
  
  /** Execution context */
  ctx: ExecContext;
  
  /** Maximum steps before throwing MaxStepsExceededError */
  maxSteps?: number;
  
  /** Callback when a tool is called (for UI updates) */
  onToolCall?: (toolName: string, toolUseId: string) => void | Promise<void>;
  
  /** Callback before LLM call (for showing "Thinking...") */
  onBeforeLLMCall?: () => void;
  
  /** Callback after tool execution with result (for showing tool output) */
  onToolResult?: (toolName: string, toolUseId: string, result: ToolResult, step: number, maxSteps: number) => void;
  
  /** Callback after each step completes (for incremental persistence) */
  onStepComplete?: () => Promise<void>;
  
  /** Tool definitions to pass to LLM for native tool_use */
  tools?: ToolDefinition[];
  
  /** Tool registry for checking readonly property (optional, enables parallel execution) */
  registry?: ToolRegistry;
  
  /** Callback for streaming text deltas (for real-time display) */
  onTextDelta?: (delta: string) => void;
  
  /** Callback when text block ends (before tool_use or turn_end) */
  onTextEnd?: () => void;
  
  /** Callback for streaming thinking deltas (for extended thinking display) */
  onThinkingDelta?: (delta: string) => void;

  /** Callback when mid-stream failover occurs (provider timed out, switching) */
  onReset?: (provider: string, timeoutMs: number) => void;

  /** Callback when a provider fails and failover continues to next provider */
  onProviderFailed?: (provider: string, model: string, error: string) => void;

  /** Callback after each LLM call for observability (audit, metrics) */
  onLLMResult?: (info: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    error?: string;
  }) => void;
}

/**
 * Result of ReAct loop
 */
export interface ReactResult {
  /** Final text response from LLM */
  finalText: string;
  
  /** Number of tool execution steps used */
  stepsUsed: number;
  
  /** Why the loop stopped */
  stopReason: 'end_turn' | 'max_steps' | 'no_tool' | 'max_tokens';
}

/**
 * Run the ReAct loop
 * 
 * This function modifies the `messages` array in-place, adding assistant
 * responses and tool results as the conversation progresses.
 */
export async function runReact(options: ReactOptions): Promise<ReactResult> {
  const {
    messages,
    systemPrompt,
    llm,
    executor,
    ctx,
    maxSteps = 20,
    onToolCall,
    onBeforeLLMCall,
    onToolResult,
    onStepComplete,
  } = options;

  let stepCount = 0;
  let consecutiveParseErrors = 0;
  let consecutiveMaxTokensToolUse = 0;
  // 每步是否全为 parse error，由 onToolResult 回调统计（在 toToolResultBlock 之前触发，有 metadata）
  let stepAllParseErrors = false;
  let stepToolCount = 0;
  let stepParseErrorCount = 0;

  while (stepCount < maxSteps) {
    // Sync step counter to context
    ctx.stepNumber = stepCount;

    // Check abort signal before LLM call
    if (ctx.signal?.aborted) {
      throwAbortError(ctx.signal);
    }

    // Notify before LLM call (for "Thinking..." display)
    safeCallback('onBeforeLLMCall', () => onBeforeLLMCall?.());

    // 流式调用 LLM，收集完整 response
    const llmStartTime = Date.now();
    let response: LLMResponse;
    try {
      response = await collectStreamResponse(llm, {
        messages,
        system: systemPrompt,
        tools: options.tools,
        maxTokens: REACT_DEFAULT_MAX_TOKENS,
        signal: ctx.signal,
      }, options.onTextDelta, options.onThinkingDelta, options.onTextEnd, options.onReset, options.onProviderFailed);
    } catch (err) {
      options.onLLMResult?.({
        model: llm.getProviderInfo?.().model ?? 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - llmStartTime,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    options.onLLMResult?.({
      model: llm.getProviderInfo?.().model ?? 'unknown',
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - llmStartTime,
    });

    // Warn on empty LLM response (provider returned no content blocks)
    if (response.content.length === 0) {
      console.warn(`[loop] LLM returned empty response (0 content blocks, stop_reason=${response.stop_reason}, latency=${Date.now() - llmStartTime}ms)`);
    }

    // Handle tool_use stop reason
    if (response.stop_reason === 'tool_use') {
      // Extract tool calls from response
      const toolCalls = extractToolCalls(response.content);
      
      if (toolCalls.length === 0) {
        // No actual tool calls found (unexpected), treat as end_turn
        console.warn('[loop] stop_reason=tool_use but no tool calls found in response');
        const text = extractText(response.content);
        appendAssistantMessage(messages, response.content);
        consecutiveMaxTokensToolUse = 0;  // 无实际截断，重置计数
        return {
          finalText: text,
          stepsUsed: stepCount,
          stopReason: 'no_tool',
        };
      }

      // Append assistant's tool_use message
      appendAssistantMessage(messages, response.content);

      // Execute tool calls: read-only tools in parallel, write tools sequentially
      // 通过内部 onToolResult 包装统计 parse error（ToolResult 有 metadata，ToolResultBlock 没有）
      stepToolCount = toolCalls.length;
      stepParseErrorCount = 0;
      const trackingOnToolResult = (toolName: string, toolUseId: string, result: ToolResult, step: number, maxSteps: number) => {
        if (result.metadata?.parseError === true) stepParseErrorCount++;
        onToolResult?.(toolName, toolUseId, result, step, maxSteps);
      };
      const toolResults = await executeToolCalls(
        toolCalls,
        executor,
        ctx,
        options.registry,
        onToolCall,
        trackingOnToolResult,
        stepCount,
        maxSteps
      );
      stepAllParseErrors = stepToolCount > 0 && stepParseErrorCount === stepToolCount;

      // 检查是否被中断（工具执行后）
      if (ctx.signal?.aborted) {
        throwAbortError(ctx.signal);
      }

      // Append tool results as user message
      appendToolResults(messages, toolResults);

      // 检测连续解析失败：LLM 持续生成格式错误的 JSON 会导致无限循环直到 maxSteps 耗尽
      if (stepAllParseErrors) {
        consecutiveParseErrors++;
        if (consecutiveParseErrors >= MAX_CONSECUTIVE_PARSE_ERRORS) {
          const toolNames = toolCalls.map(t => t.name).join(', ');
          throw new Error(
            `工具输入 JSON 连续解析失败 ${MAX_CONSECUTIVE_PARSE_ERRORS} 次（工具: ${toolNames}），终止执行`
          );
        }
      } else {
        consecutiveParseErrors = 0;
      }

      // 重置连续 max_tokens+tool_use 计数器
      consecutiveMaxTokensToolUse = 0;

      // Increment step and continue loop
      ctx.incrementStep();
      stepCount = ctx.stepNumber;

      // Call step completion callback (audit log must succeed)
      if (onStepComplete) {
        await onStepComplete();
      }
      
      continue;
    }

    // Handle end_turn stop reason (final answer)
    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop') {
      const text = extractText(response.content);
      appendAssistantMessage(messages, response.content);
      return {
        finalText: text,
        stepsUsed: stepCount,
        stopReason: 'end_turn',
      };
    }

    // Handle max_tokens stop reason
    if (response.stop_reason === 'max_tokens') {
      const toolCalls = extractToolCalls(response.content);
      if (toolCalls.length > 0) {
        // tool_use 被截断：检查连续次数，补 tool_result，继续 loop
        consecutiveMaxTokensToolUse++;
        if (consecutiveMaxTokensToolUse >= MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE) {
          throw new Error(
            `LLM 连续 ${MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE} 次 max_tokens 截断 tool_use，终止执行。请减少 system prompt 或 tool schema 体积。`
          );
        }
        appendAssistantMessage(messages, response.content);
        const truncatedResults: ToolResultBlock[] = toolCalls.map(tc => ({
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content: `[TRUNCATED] 输出超过单次 token 上限（${REACT_DEFAULT_MAX_TOKENS} tokens），工具调用被截断未执行。请将内容拆分为多次较小的调用。`,
          is_error: true,
        }));
        appendToolResults(messages, truncatedResults);
        // 不增加 stepCount，不调 onStepComplete，继续 loop
        continue;
      } else {
        // 纯文本截断：行为不变
        const text = extractText(response.content);
        appendAssistantMessage(messages, response.content);
        return {
          finalText: text + '\n\n[Response truncated due to length limit]',
          stepsUsed: stepCount,
          stopReason: 'max_tokens',
        };
      }
    }

    // Context window exceeded — input too large for the model
    if (response.stop_reason === 'model_context_window_exceeded' || response.stop_reason === 'context_length_exceeded') {
      throw new Error(
        `LLM context window exceeded (stop_reason=${response.stop_reason}). ` +
        `Reduce system prompt, tool definitions, or conversation history.`
      );
    }

    // Unknown stop reason — treat as end_turn but warn
    console.warn(`[loop] Unknown stop_reason: "${response.stop_reason}", treating as end_turn`);
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    return {
      finalText: text,
      stepsUsed: stepCount,
      stopReason: 'end_turn',
    };
  }

  // Max steps exceeded
  throw new MaxStepsExceededError(maxSteps);
}

/**
 * Execute tool calls with parallel optimization for read-only tools
 * 
 * - Read-only tools: executed in parallel
 * - Write tools: executed sequentially
 * - Results are assembled in original order
 */
async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  registry: ToolRegistry | undefined,
  onToolCall?: (toolName: string, toolUseId: string) => void | Promise<void>,
  onToolResult?: (toolName: string, toolUseId: string, result: ToolResult, step: number, maxSteps: number) => void,
  stepCount: number = 0,
  maxSteps: number = 20,
): Promise<ToolResultBlock[]> {
  // If no registry, fall back to sequential execution
  if (!registry) {
    const toolResults: ToolResultBlock[] = [];
    for (const toolCall of toolCalls) {
      if (ctx.signal?.aborted) throwAbortError(ctx.signal);
      await safeCallbackAsync('onToolCall', async () => await onToolCall?.(toolCall.name, toolCall.id));
      const result = await executeSingleTool(toolCall, executor, ctx);
      safeCallback('onToolResult', () => onToolResult?.(toolCall.name, toolCall.id, result, stepCount, maxSteps));
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
    await safeCallbackAsync('onToolCall', async () => await onToolCall?.(call.name, call.id));
    const result = await executeSingleTool(call, executor, ctx);
    safeCallback('onToolResult', () => onToolResult?.(call.name, call.id, result, stepCount, maxSteps));
    results.set(index, toToolResultBlock(call.id, result));
  }

  // Execute readonly sync tools in parallel
  if (readonlySyncCalls.length > 0) {
    // Notify UI for all readonly calls (before parallel execution)
    for (const { call } of readonlySyncCalls) {
      await safeCallbackAsync('onToolCall', async () => await onToolCall?.(call.name, call.id));
    }

    // Prepare batch for parallel execution
    const batch = readonlySyncCalls.map(({ call }) => {
      const { async: _asyncMode, ...toolArgs } = call.input as Record<string, unknown>;
      return {
        toolName: call.name,
        args: toolArgs,
      };
    });

    // Execute parallel batch
    const parallelResults = await executor.executeParallel(batch, ctx);

    // Notify UI and store results in original order
    for (let i = 0; i < readonlySyncCalls.length; i++) {
      const { call, index } = readonlySyncCalls[i];
      const result = parallelResults[i];
      safeCallback('onToolResult', () => onToolResult?.(call.name, call.id, result, stepCount, maxSteps));
      results.set(index, toToolResultBlock(call.id, result));
    }
  }

  // Execute write tools sequentially
  for (const { call, index } of writeCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    await safeCallbackAsync('onToolCall', async () => await onToolCall?.(call.name, call.id));
    const result = await executeSingleTool(call, executor, ctx);
    safeCallback('onToolResult', () => onToolResult?.(call.name, call.id, result, stepCount, maxSteps));
    results.set(index, toToolResultBlock(call.id, result));
  }

  // Assemble results in original order
  return toolCalls.map((_, i) => {
    const r = results.get(i);
    if (!r) throw new Error(`[loop] Missing result for tool call at index ${i}`);
    return r;
  });
}

/**
 * Execute a single tool with error handling
 */
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
    console.error(`[react/loop] Tool ${toolCall.name} execution failed:`, errorMsg);
    return {
      success: false,
      content: `[${errorType}] 工具执行失败: ${errorMsg}`,
    };
  }
}

/**
 * Convert ToolResult to ToolResultBlock
 */
function toToolResultBlock(toolUseId: string, result: ToolResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: result.content,
    is_error: !result.success,
  };
}

/**
 * Collect stream chunks into a complete response
 */
async function collectStreamResponse(
  llm: ILLMService,
  callOptions: LLMCallOptions,
  onTextDelta?: (delta: string) => void,
  onThinkingDelta?: (delta: string) => void,
  onTextEnd?: () => void,
  onReset?: (provider: string, timeoutMs: number) => void,
  onProviderFailed?: (provider: string, model: string, error: string) => void,
): Promise<LLMResponse> {
  const contentBlocks: ContentBlock[] = [];
  let currentText = '';
  let currentThinking = '';
  let currentSignature = '';
  let currentToolUse: { id: string; name: string; input: string } | null = null;
  let stopReason = 'end_turn';
  let usage: { input_tokens: number; output_tokens: number } | undefined;

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
            onTextDelta?.(chunk.delta);
          }
          break;

        case 'thinking_delta':
          if (chunk.delta) {
            currentThinking += chunk.delta;
            onThinkingDelta?.(chunk.delta);
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
            onTextEnd?.();
          }
          // 保存之前的 tool_use（如果有多个）
          if (currentToolUse) {
            contentBlocks.push({
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: JSON.parse(currentToolUse.input || '{}'),
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
          onReset?.(chunk.provider ?? 'unknown', chunk.timeoutMs ?? 0);
          break;

        case 'provider_failed':
          onProviderFailed?.(chunk.provider ?? 'unknown', chunk.model ?? 'unknown', chunk.error ?? 'unknown error');
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
    // Provider（anthropic/openai）在 signal 被 abort 时抛出 Error('Execution aborted')，
    // 但丢失了 signal.reason，无法区分 idle timeout 和用户中断。
    // 此处用 signal.reason 重新生成正确的错误类型。
    if (callOptions.signal?.aborted) {
      throwAbortError(callOptions.signal);
      // throwAbortError 是 never，不会 fall through
    }
    throw err;
  }

  // 保存最后的 blocks
  if (currentThinking) {
    contentBlocks.push({ type: 'thinking', thinking: currentThinking, signature: currentSignature });
  }
  if (currentText) {
    contentBlocks.push({ type: 'text', text: currentText });
    onTextEnd?.();
  }
  if (currentToolUse) {
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = JSON.parse(currentToolUse.input || '{}');
    } catch (err) {
      console.error(`[loop] Failed to parse tool input for "${currentToolUse.name}": ${err instanceof Error ? err.message : String(err)}`);
      parsedInput = { __parseError: true, __raw: currentToolUse.input ?? '' };
    }
    contentBlocks.push({
      type: 'tool_use',
      id: currentToolUse.id,
      name: currentToolUse.name,
      input: parsedInput,
    } as ContentBlock);
    currentToolUse = null;
  }

  return {
    content: contentBlocks,
    stop_reason: stopReason,
    usage,
  };
}

/**
 * Extract tool_use blocks from content
 */
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

/**
 * Extract text content from response
 */
function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => 
      block.type === 'text'
    )
    .map(block => block.text)
    .join('')
    .trim();
}

/**
 * Append assistant message to conversation
 */
function appendAssistantMessage(messages: Message[], content: ContentBlock[]): void {
  messages.push({
    role: 'assistant',
    content,
  });
}

/**
 * Append tool results as user message
 */
function appendToolResults(messages: Message[], results: ToolResultBlock[]): void {
  messages.push({
    role: 'user',
    content: results,
  });
}
