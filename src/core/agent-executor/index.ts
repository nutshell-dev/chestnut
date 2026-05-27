/**
 * @module L3.AgentExecutor
 * AgentExecutor module (L3) — agent 完整循环算法
 *
 * arch §19: 「跑 agent 循环的算法原语 / 不持业务语义 / L3 agent 原语 ——『agent 循环』」
 *
 * runReact 是 AgentExecutor 的便捷装配 entry（向后兼容 shim from phase183）
 */

// runAgent: agent-executor module internal core / 仅 loop.ts internal 调 / 不进 barrel（M#8 单 public API / phase 522 / ν）
export type { AgentInput, AgentResult } from './agent-executor.js';

// runReact shim（装配 StepExecutor + AgentExecutor 完整 React 循环）
export { runReact } from './loop.js';
export type { ReactOptions, ReactResult } from './loop.js';
export { DEFAULT_MAX_STEPS } from './defaults.js';
export { AGENT_STREAM_EVENTS } from './stream-events.js';
