/**
 * AgentExecutor stream event names.
 *
 * Agent loop（turn / llm / tool）生命周期 event vocabulary、写入 stream.jsonl 的 `type` 字段。
 * mirror async-task-system/stream-events.ts 模板（task lifecycle）+ audit-events.ts 模板（phase 749 既成）。
 *
 * phase 755 NEW（D1 cluster B、修真违反 M#9 编译器可检 + D5 日志重建、agent.ts + daemon-loop.ts 17 emit sites cascade）。
 */
export const AGENT_STREAM_EVENTS = {
  TURN_START: 'turn_start',
  LLM_START: 'llm_start',
  TEXT_DELTA: 'text_delta',
  THINKING_DELTA: 'thinking_delta',
  TEXT_END: 'text_end',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  TURN_END: 'turn_end',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_ERROR: 'turn_error',
} as const;
