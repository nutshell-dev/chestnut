/**
 * @module L3.AgentExecutor
 * AgentExecutor module (L3) — agent 完整循环算法
 *
 * arch §19: 「跑 agent 循环的算法原语 / 不持业务语义 / L3 agent 原语 ——『agent 循环』」
 *
 * runReact 是 AgentExecutor 的便捷装配 entry（向后兼容 shim from phase183）
 */

// runAgent: agent-executor module internal core / 仅 loop.ts internal 调 / 不进 barrel（M#8 单 public API / phase 522 / ν）

// runReact shim（装配 StepExecutor + AgentExecutor 完整 React 循环）
export { runReact } from './loop.js';
export type { ReactOptions, ReactResult, ReactStepCallbacks } from './loop.js';
export { commitTurnEvent } from './turn-event-commit.js';
export type { TurnEvent, TurnEventCommitDeps } from './turn-event-commit.js';
export {
  MaxStepsExceededError,
  ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError,
  WallTimeExceededError,
} from './errors.js';
export type { StreamCallbacks } from './stream-callbacks.js';
export { makeStepNumber } from './step-number.js';

// phase 1789: 跨层 stream 事件常量迁回语义 owner subagent/stream-events.ts（本模块不再持有 catalog）
export { agentExecutorConfigSchema } from './config-schema.js';
