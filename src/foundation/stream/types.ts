/**
 * Stream module types (L2)
 */

/**
 * stream.jsonl 相对路径常量
 */
export const STREAM_FILE = 'stream.jsonl';

/**
 * stream.jsonl type 权威判别联合（phase 1309 治理）。
 * 成员 = 写端全集并集（phase 1308 盘点）：主 stream 49 + task 专属 3 + 幽灵 1 = 53。
 * 分组注释按写端模块；新增事件类型必须先加到此联合（编译器检查写端与消费端覆盖）。
 */
export type StreamEventType =
  // agent-executor AGENT_STREAM_EVENTS（13）
  | 'turn_start' | 'llm_start' | 'thinking_delta' | 'text_delta' | 'text_end'
  | 'tool_call' | 'tool_use_input' | 'user_reply_delta' | 'user_reply_end'
  | 'tool_result' | 'turn_end' | 'turn_interrupted' | 'turn_error'
  // agent-executor stream-callbacks 裸字面量（3）
  | 'provider_info' | 'provider_failover' | 'provider_failed'
  // event-loop（1）
  | 'llm_retry_waiting'
  // llm-orchestrator LLMEvent 全量转发（27）
  | 'provider_attempt_failed' | 'retry_scheduled' | 'provider_exhausted'
  | 'fallback_switched' | 'breaker_opened' | 'breaker_half_open' | 'breaker_closed'
  | 'healthcheck_failed' | 'stream_reset' | 'stream_parse_error' | 'tool_arg_parse_error'
  | 'idle_failover_triggered' | 'stream_idle_probe_attempted' | 'stream_idle_probe_succeeded'
  | 'context_exceeded_failover' | 'context_exceeded_throwthrough' | 'permanent_skip_retry'
  | 'hedge_started' | 'hedge_primary_recovered' | 'hedge_primary_post_first_chunk_failure'
  | 'hedge_fallback_committed' | 'hedge_primary_succeeded_after_race_lost'
  | 'all_providers_context_exceeded' | 'race_loser_cleaned'
  | 'sdk_client_cache_hit' | 'sdk_client_cache_miss' | 'provider_close_failed'
  // contract 通知 / CLI co-writer / audit jobs（3）
  | 'user_notify' | 'contract_events' | 'contract_cancelled'
  // assembly daemon 启动（1）
  | 'daemon_started'
  // stream writer 归档（1）
  | 'session_boundary'
  // async-task-system task 生命周期（parent stream 2 + task stream 1）
  | 'task_started' | 'task_completed' | 'task_attempt_start'
  // 幽灵类型：user_reply 无写端（LLM_OUTPUT_EVENTS + event-handler case 保留、
  // 处置论证留 phase 1309 完成后深挖）
  | 'user_reply';

/**
 * stream.jsonl 中的单行事件
 */
export interface StreamEvent {
  ts: number;
  type: StreamEventType;
  [key: string]: unknown;
}

/**
 * stream.jsonl 写入接口（由 StreamWriter 结构兼容，无需 implements 声明）
 */
export interface StreamLog {
  write(event: StreamEvent): void;
}

/**
 * Direct LLM output event types (excludes infrastructure events like llm_start/tool_result).
 * Used by watchdog (claw activity tracking) and chat-viewport (UI rendering).
 */
export const LLM_OUTPUT_EVENTS = new Set(['thinking_delta', 'text_delta', 'tool_call', 'user_reply', 'user_reply_delta', 'user_reply_end']);
