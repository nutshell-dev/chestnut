/**
 * @module L3.StepExecutor
 * ReAct module - StepExecutor + AgentExecutor + runReact shim
 */

// Shim（向后兼容）
export { runReact } from './loop.js';
export type { ReactOptions, ReactResult } from './loop.js';

// StepExecutor（新契约）
export { executeStep } from './step-executor.js';
export { throwAbortError } from './abort-helpers.js';
export type {
  StepInput, StepResult, StepCallbacks, StepMeta, LLMCallInfo,
} from './step-executor.js';

// AgentExecutor（新契约）
export { runAgent } from './agent-executor.js';
export type { AgentInput, AgentResult } from './agent-executor.js';
