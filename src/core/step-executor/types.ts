/**
 * @module L3.StepExecutor.Types
 * Step type definitions — extracted from step-executor.ts
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext, IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';

export interface LLMCallInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
}

/**
 * phase 440: ContextManager runtime config injected at assembly time.
 *
 * phase 690: StepExecutor 不再持 proactive trim、本 type 保留供 Runtime
 * 反应式 trim+retry 路径用（runtime.contextManagerConfig 字段类型）。
 */
export interface ContextManagerRuntimeConfig {
  filterSubtypes: ReadonlySet<string>;
}

export interface StepCallbacks {
  onBeforeLLMCall?: () => void;
  onLLMResult?: (info: LLMCallInfo) => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: ToolUseId) => void | Promise<void>;
  /**
   * phase 1411: fires after args fully parsed (post LLM stream complete) and
   * before executor.execute. Carries full args (post parse-failure guard).
   *
   * Distinct from onToolCall (tool_use_start, args not yet streamed) —
   * onToolCallInput is the audit-quality emit point. SubAgent uses it to emit
   * `tool_call_input` index row (name + tool_use_id + args_size) per
   * design/modules/l3_subagent.md §A.phase1409-on-tool-call-args-emit
   * (amended-by phase 1411).
   */
  onToolCallInput?: (toolName: string, toolUseId: ToolUseId, args: Record<string, unknown>) => void;
  /**
   * phase 688: fires inside flushToolUse / finalizeContent when args parse succeeds.
   * Distinct from onToolCallInput (post-stream, pre-execute, audit-only args_size index).
   * onToolUseInput is the stream.jsonl emit point for the **args body**, restoring
   * stream.jsonl 流式产物全文契约（既有 text_delta / thinking_delta 已落 body、tool_use 仍漏）。
   * 失败 parse 分支不 fire（占位 tool_use input={} 已由 phase 1282 既有路径处理）。
   * 正常成功路径 + 异常 catch 路径 drain 都走此回调（API 发来的 input 必落盘、不被静默丢弃）。
   */
  onToolUseInput?: (toolName: string, toolUseId: ToolUseId, input: Record<string, unknown>) => void;
  /**
   * phase 688: catch 路径丢弃 partial assistant content（含 in-flight tool_use + text + thinking）
   * 这一**决策动作**的可观测点。args body 已由 onToolUseInput 落 stream.jsonl、本回调只载决策摘要。
   * cause = 丢弃原因分类（与 classifyLLMError 互补、聚焦 collector catch 触发场景）。
   * 不传 tool_use_id 列表（audit 不膨胀、CLI 凭 trace_id + ts_range join stream.jsonl）。
   */
  onPartialAssistantDiscarded?: (info: {
    cause: 'all_providers_failed' | 'idle_timeout' | 'unknown';
    toolUseCount: number;
    hasText: boolean;
    hasThinking: boolean;
    startTs: number;
    endTs: number;
    errMessage: string;
  }) => void;
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: ToolResult) => void;
  onReset?: (provider: string, timeoutMs: number) => void;
  onProviderFailed?: (provider: string, model: string, error: string) => void;
  onEmptyResponse?: (stopReason: string) => void;
  onUnknownStopReason?: (stopReason: string) => void;
  onUnparseableToolUse?: (stopReason: string) => void;
  onToolInputParseError?: (toolName: string, toolUseId: ToolUseId, rawInput: string) => void;
  onToolExecutionFailed?: (toolName: string, toolUseId: ToolUseId, errorType: string, errorMsg: string) => void;
  onSafeCallbackError?: (label: string, err: unknown) => void;
  onMessageAppended?: (role: 'assistant' | 'user', blocks: number) => void;
  onMaxTokensPrebuiltOnlyFinal?: (meta: { prebuiltCount: number; llm: LLMCallInfo }) => void;
  onMaxTokensAssistantEmptySkipped?: (meta: { llm: LLMCallInfo }) => void;
  /** phase 1383: State A orphan prebuilt drop observability */
  onMaxTokensStateAOrphanDrop?(args: {
    orphans: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
    llm: LLMCallInfo;
  }): void;
}

export interface StepInput {
  messages: Message[];
  systemPrompt: string;
  llm: LLMOrchestrator;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;
  ctx: ExecContext;
  maxTokens?: number;
  idleTimeoutMs?: number;
  callbacks?: StepCallbacks;
  /** phase 732: injected by AgentExecutor for internal audit writes. */
  auditWriter?: AuditLog;
  /** phase 732: contract id for audit context. */
  currentContractId?: string;
  // phase 690: 撤 dialogStore + contextManagerConfig — proactive trim
  // 上提到 L5 Runtime 反应式 retry 路径、StepExecutor 不再持 trim 业务。
}

export interface StepMeta {
  toolCallCount: number;
  parseErrorCount: number;
  allParseErrors: boolean;
  llm: LLMCallInfo;
  /** Stream-layer parse-error tool names (when no tool_use blocks exist in assistant message) */
  toolNames?: string;
}

/** Brand symbol — caller 无法构造、唯一通道是 asFinalStopReason factory */
declare const __FSR_brand: unique symbol;

/**
 * FinalStopReason 单源 const（M#3 资源唯一归属、ML#1 共用基础设施单源）。
 *
 * Producer 必经 asFinalStopReason() / tryAsFinalStopReason() 构造、
 * 不可直接字面 string assign 到 FinalStopReason type（brand 阻挡）。
 */
export const FINAL_STOP_REASONS = [
  'end_turn',
  'stop',
  'max_tokens_text',
  'no_tool',
  'content_filter',
  'unknown',
] as const;

type RawFinalStopReason = typeof FINAL_STOP_REASONS[number];

/**
 * 字面联合 + brand intersection。
 * caller 写 `const x: FinalStopReason = 'end_turn'` 编译 fail（缺 brand）。
 * caller 必经 `asFinalStopReason('end_turn')` 构造（M#9 优先编译期检查）。
 */
export type FinalStopReason = (RawFinalStopReason & { readonly [__FSR_brand]: never });

/**
 * 唯一构造入口（producer 已知 RawFinalStopReason value）。
 */
export function asFinalStopReason(s: RawFinalStopReason): FinalStopReason {
  return s as FinalStopReason;
}

/**
 * Raw LLM string → typed FinalStopReason validate + 构造。
 * 用于 step-executor.ts:98 dynamic 路径（raw LLM response.stop_reason）。
 * 返回 undefined 时 caller 应走 onUnknownStopReason callback + fallback。
 */
export function tryAsFinalStopReason(s: string): FinalStopReason | undefined {
  return (FINAL_STOP_REASONS as readonly string[]).includes(s)
    ? (s as FinalStopReason)
    : undefined;
}

export type StepResult =
  | { kind: 'final'; stopReason: FinalStopReason; finalText: string }
  | { kind: 'continue'; meta: StepMeta }
  | { kind: 'max_tokens_tool_use'; meta: StepMeta };
