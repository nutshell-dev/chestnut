/**
 * @module L3.StepExecutor.RecoveryDelivery
 * Phase 1933 Step C：严格恢复交付契约 —— 完整 LLM 响应 / 工具意图 / 工具结果事实
 * 在副作用前（或副作用后即刻）经本通道 await 提交，失败传播、中止 step。
 *
 * 与既有 StepCallbacks（通知语义、[B:safe]/[S:strict] 分级）独立：
 * 本接口是「持久化事实交付」通道，实现方负责持久化语义，本模块只定义契约与调用点。
 */

import type { LLMResponse, ToolUseId } from '../../foundation/llm-provider/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';

/**
 * LLM 调用事实载荷（结构性兼容 types.ts 的 LLMCallInfo）。
 * 不从 types.js import LLMCallInfo：types.ts 的 StepInput 引用本模块 RecoveryDelivery，
 * 反向 import 会成环（lint-arch no-circular）——模式对齐 audit-sink.ts 的
 * StepEventLlmCallInfo 先例（同层协议类型各自 own、结构性兼容）。
 */
export interface RecoveryLLMCallInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
}

/** 完整 LLM 响应事实（副作用前的严格提交点；仅流完整结束后才允许提交）。 */
export interface CompleteLLMResponse {
  response: LLMResponse;       // 完整响应（content blocks、stop_reason、usage）
  llmInfo: RecoveryLLMCallInfo;
  committedAtMs: number;
}

/** 工具调用意图事实（executor.execute 副作用前的严格提交点）。 */
export interface ToolStartedFact {
  toolUseId: ToolUseId;
  toolName: string;
  input: Record<string, unknown>;
  startedAtMs: number;
}

/** 工具结果事实（execute 返回后即刻提交；提交失败传播，副作用已发生不可撤销）。 */
export interface ToolResultFact {
  toolUseId: ToolUseId;
  toolName: string;
  result: ToolResult;
  resultAtMs: number;
}

/**
 * Phase 1933 Step C：严格恢复交付接口。
 * 三个方法全部 await；任一 reject 即阻断后续副作用（传播给调用方中止 step）。
 * 实现方负责持久化语义；本模块只定义契约与调用点。
 */
export interface RecoveryDelivery {
  llmResponseCommitted(fact: CompleteLLMResponse): Promise<void>;
  toolStarted(fact: ToolStartedFact): Promise<void>;
  toolResultCommitted(fact: ToolResultFact): Promise<void>;
}
