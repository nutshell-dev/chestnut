/**
 * @module L3.StepExecutor.Types
 * Step type definitions — extracted from step-executor.ts
 */

import type { ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext, IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolUseId } from '../../foundation/llm-provider/index.js';
import type { StepExecutorEventSink } from './audit-sink.js';

export interface LLMCallInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
}

/**
 * phase 1857 Step F (SE-D6): 逐项失败策略声明（契约）。
 *
 * 三组分类与策略：
 * - **stream delivery**（流式展示面）：onTextDelta / onTextEnd / onThinkingDelta /
 *   onToolUseInputDelta / onToolUseInput / onToolCall / onReset / onProviderFailed
 * - **提交通知**（提交/交付事实通知）：onToolCallInput / onMessageAppended /
 *   onToolResult / onLLMResult
 * - **裁决事件**（决策可观测点）：onPartialAssistantDiscarded / onEmptyResponse /
 *   onUnknownStopReason / onUnparseableToolUse / onToolInputParseError /
 *   onToolExecutionFailed / onMaxTokens*(3)
 *
 * 策略两级：
 * - `[B:safe]` 失败经 onSafeCallbackError 留证（+ audit 写点，writer 在作用域时），不终止 step。
 *   副作用已发生的通知一律 B 级——callback 失败不得改变已发生提交。
 * - `[S:strict]` 失败传播、可中止 step（裸调，无 safeCallback 包裹）。
 *   仅用于副作用发生前的事实交付决策点：onLLMResult。
 *   （实施注记：计划基线曾列 onBeforeLLMCall 为 S 级；其现状为 safeCallback 包裹且
 *   phase 890 reverse 测试锁定「throw 不中断 step」，按既有契约保留 B 级，偏差已登记。）
 */
export interface StepCallbacks {
  /** [B:safe][提交通知] 既有契约（phase 890）：失败经 onSafeCallbackError 留证，不终止 step。 */
  onBeforeLLMCall?: () => void;
  /** [S:strict][提交通知] LLM 调用事实交付（成功/失败两路，副作用提交前）；失败传播、可中止 step。 */
  onLLMResult?: (info: LLMCallInfo) => void;
  /** [B:safe][stream delivery] */
  onTextDelta?: (delta: string) => void;
  /** [B:safe][stream delivery] */
  onTextEnd?: () => void;
  /** [B:safe][stream delivery] */
  onThinkingDelta?: (delta: string) => void;
  /** [B:safe][stream delivery] */
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
  /**
   * [B:safe][提交通知]
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
  /**
   * [B:safe][stream delivery]
   * phase 688: fires inside flushToolUse / finalizeContent when args parse succeeds.
   * Distinct from onToolCallInput (post-stream, pre-execute, audit-only args_size index).
   * onToolUseInput is the stream.jsonl emit point for the **args body**, restoring
   * stream.jsonl 流式产物全文契约（既有 text_delta / thinking_delta 已落 body、tool_use 仍漏）。
   * 失败 parse 分支不 fire（占位 tool_use input={} 已由 phase 1282 既有路径处理）。
   * 正常成功路径 + 异常 catch 路径 drain 都走此回调（API 发来的 input 必落盘、不被静默丢弃）。
   */
  onToolUseInput?: (toolName: string, toolUseId: ToolUseId, input: Record<string, unknown>) => void;
  /** [B:safe][stream delivery] phase 1180: raw partial JSON input on each tool_use_delta */
  onToolUseInputDelta?: (toolName: string, toolUseId: ToolUseId, partialInput: string) => void;
  /**
   * phase 688: catch 路径丢弃 partial assistant content（含 in-flight tool_use + text + thinking）
   * 这一**决策动作**的可观测点。args body 已由 onToolUseInput 落 stream.jsonl、本回调只载决策摘要。
   * cause = 丢弃原因分类（与 classifyLLMError 互补、聚焦 collector catch 触发场景）。
   * 不传 tool_use_id 列表（audit 不膨胀、CLI 凭 trace_id + ts_range join stream.jsonl）。
   */
  /**
   * [B:safe][裁决事件] 副作用（丢弃）已发生，通知失败不得改变 step 终态。
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
  /** [B:safe][提交通知] */
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: ToolResult) => void;
  /** [B:safe][stream delivery] provider reset 已发生后的展示通知。 */
  onReset?: (provider: string, timeoutMs: number) => void;
  /** [B:safe][stream delivery] provider 失败已发生后的展示通知。 */
  onProviderFailed?: (provider: string, model: string, error: string) => void;
  /** [B:safe][裁决事件] */
  onEmptyResponse?: (stopReason: string) => void;
  /** [B:safe][裁决事件] */
  onUnknownStopReason?: (stopReason: string) => void;
  /** [B:safe][裁决事件] */
  onUnparseableToolUse?: (stopReason: string) => void;
  /** [B:safe][裁决事件] */
  onToolInputParseError?: (toolName: string, toolUseId: ToolUseId, rawInput: string) => void;
  /** [B:safe][裁决事件] 工具失败已发生，通知失败不得改变已记录失败。 */
  onToolExecutionFailed?: (toolName: string, toolUseId: ToolUseId, errorType: string, errorMsg: string) => void;
  /**
   * [reporter] safeCallback 失败上报通道（B 级 callback 的首错留证）。
   * 由 safeCallback 内部受保护调用：本 reporter 自身 throw 不逃逸、不覆盖首错、
   * 不阻断 audit 留证（零递归 console 边界承接二级失败，phase 1812 Step B）。
   */
  onSafeCallbackError?: (label: string, err: unknown) => void;
  /** [B:safe][提交通知] 消息已提交入 buffer，通知失败不得改变已发生提交。 */
  onMessageAppended?: (role: 'assistant' | 'user', blocks: number) => void;
  /** [B:safe][裁决事件] */
  onMaxTokensPrebuiltOnlyFinal?: (meta: { prebuiltCount: number; llm: LLMCallInfo }) => void;
  /** [B:safe][裁决事件] */
  onMaxTokensAssistantEmptySkipped?: (meta: { llm: LLMCallInfo }) => void;
  /** [B:safe][裁决事件] phase 1383: State A orphan prebuilt drop observability */
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
  /**
   * phase 1857 Step I (SE-D9): 单一事件出口——裁决事实经结构化 sink 恰好发出一次；
   * 展示（callbacks）与持久化（audit 行，contract_id/trace_id 绑定）由 caller adapter 组合。
   * （撤 phase 732 的审计写入注入面与审计专用 contract id 字段——身份绑定归 caller adapter。）
   */
  eventSink?: StepExecutorEventSink;
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
