/**
 * agent-executor 自有 stream 事件（ReAct 循环生命周期 + 工具执行结果，phase 1321 分层拆件）。
 * LLM 输出事件（thinking_delta / tool_use_input / send_content_* 等）归 stream 协议层、不在此——
 * tool_result 是工具真执行后的产物（onToolResult 回调）、与 LLM 生成的 tool_use input 流不同阶段。
 * 全量判别联合（含本 const 的 payload）归 CLI 汇总（cli/commands/stream-event-types.ts）。
 */
export const STREAM_AGENT_EVENTS = {
  TURN_START: 'turn_start',
  LLM_START: 'llm_start',
  TOOL_RESULT: 'tool_result',
  TURN_END: 'turn_end',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_ERROR: 'turn_error',
} as const;
