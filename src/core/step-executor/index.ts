/**
 * @module L3.StepExecutor
 * StepExecutor module (L3) — 单步 LLM 调用 + tool execution
 *
 * arch §18: 「agent 单步执行的原语 / L3 agent 原语 ——『单步 LLM 调用』」
 */

export { executeStep } from './step-executor.js';
export { StepAbortError, isStepAbortError, throwAbortError, abortEvidenceAuditCols } from './abort-helpers.js';
export type { StepAbortReason } from './abort-helpers.js';
export type { StepExecutorEventSink, StepEventLlmCallInfo } from './audit-sink.js';
export { safeCallback, writeAuditGuarded } from './utils.js';
export { STEP_EXECUTOR_AUDIT_EVENTS } from './audit-events.js';
export { createStepExecutorEventSink } from './caller-event-sink.js';
export { asFinalStopReason } from './types.js';
// Phase 1933 Step C: 严格恢复交付契约（独立通道，不改既有 callback 语义）
export type {
  RecoveryDelivery, CompleteLLMResponse, ToolStartedFact, ToolResultFact, RecoveryLLMCallInfo,
} from './recovery-delivery.js';
export type {
  StepCallbacks, StepMeta, LLMCallInfo, FinalStopReason,
  StepInput, StepResult,
} from './types.js';
