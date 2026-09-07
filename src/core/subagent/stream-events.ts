/**
 * @module L3.SubAgent.StreamEvents
 * subagent 语义 owner：agent turn 生命周期 wire 事件常量（phase 1789 从 agent-executor 迁回）。
 *
 * main runtime（event-loop）与 subagent runtime 共用同一 turn 事件词汇；单一 owner
 * 避免 event-loop↔subagent 双向 import 成环（no-circular）。事件字符串/payload 不变；
 * AgentExecutor 不再拥有跨层事件 catalog（仅消费最小 StreamCallbacks 协议）；
 * CLI 汇总经稳定 wire catalog（cli/commands/stream-event-types.ts）、不导入本 owner。
 */
export const SUBAGENT_EVENTS = {
  TURN_START: 'turn_start',
  LLM_START: 'llm_start',
  TOOL_RESULT: 'tool_result',
  TURN_END: 'turn_end',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_ERROR: 'turn_error',
} as const;

export type SubagentEvent = (typeof SUBAGENT_EVENTS)[keyof typeof SUBAGENT_EVENTS];
