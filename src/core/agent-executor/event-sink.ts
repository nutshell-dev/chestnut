/**
 * @module L3.AgentExecutor.EventSink
 * @layer L3 agent 原语
 * @consumers L4.Runtime（caller adapter 绑定身份/格式化）、L3.AgentExecutor（produce）
 *
 * phase 1856 (AE-D9): AgentExecutor-owned 结构化事件 sink。
 * 循环只发结构化事实（工具名/step/id/结果字段）；contract_id/trace_id 身份绑定
 * 与审计存储格式化归 caller adapter（runtime）。审计存储接口与业务关联字段
 * 不再进入循环实现。模式对齐 L2 已落地的 owner-local sink（DialogStore/PM）。
 */

import type { ToolUseId } from '../../foundation/llm-provider/index.js';

export interface AgentExecutorEventSink {
  /** 工具参数 JSON 完整解析后（post-stream, pre-execute）触发；argsSize 为序列化长度。 */
  toolCallInput(e: { toolName: string; toolUseId: ToolUseId; step: number; argsSize: number }): void;
  /** 工具执行完成后触发；content 为结果全文（截断/摘要归消费侧）。 */
  toolResult(e: { toolName: string; toolUseId: ToolUseId; step: number; success: boolean; content: string }): void;
  /** 完整 step 落定后触发（continue 与 max_tokens_tool_use 两分支同序）。 */
  stepCompleted(e: { step: number }): void;
}
