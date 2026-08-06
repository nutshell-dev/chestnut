/**
 * Stream module types (L2)
 */

/**
 * stream.jsonl 相对路径常量
 */
export const STREAM_FILE = 'stream.jsonl';

/**
 * stream.jsonl type 权威单源 const（phase 1312 治理）。
 * StreamEventType 由本 const 派生（typeof）→ 值集合 0 漂移。
 * 写端一律引用 STREAM_EVENT_NAMES.X（禁裸字面量）；新增事件类型先加此 const。
 */
export const STREAM_EVENT_NAMES = {
  // agent-executor（13）
  TURN_START: 'turn_start',
  LLM_START: 'llm_start',
  THINKING_DELTA: 'thinking_delta',
  TEXT_DELTA: 'text_delta',
  TEXT_END: 'text_end',
  TOOL_CALL: 'tool_call',
  TOOL_USE_INPUT: 'tool_use_input',
  USER_REPLY_DELTA: 'user_reply_delta',
  USER_REPLY_END: 'user_reply_end',
  TOOL_RESULT: 'tool_result',
  TURN_END: 'turn_end',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_ERROR: 'turn_error',
  // agent-executor stream-callbacks 裸字面量（3）
  PROVIDER_INFO: 'provider_info',
  PROVIDER_FAILOVER: 'provider_failover',
  PROVIDER_FAILED: 'provider_failed',
  // event-loop（1）
  LLM_RETRY_WAITING: 'llm_retry_waiting',
  // llm-orchestrator LLMEvent（27）
  PROVIDER_ATTEMPT_FAILED: 'provider_attempt_failed',
  RETRY_SCHEDULED: 'retry_scheduled',
  PROVIDER_EXHAUSTED: 'provider_exhausted',
  FALLBACK_SWITCHED: 'fallback_switched',
  BREAKER_OPENED: 'breaker_opened',
  BREAKER_HALF_OPEN: 'breaker_half_open',
  BREAKER_CLOSED: 'breaker_closed',
  HEALTHCHECK_FAILED: 'healthcheck_failed',
  STREAM_RESET: 'stream_reset',
  STREAM_PARSE_ERROR: 'stream_parse_error',
  TOOL_ARG_PARSE_ERROR: 'tool_arg_parse_error',
  IDLE_FAILOVER_TRIGGERED: 'idle_failover_triggered',
  STREAM_IDLE_PROBE_ATTEMPTED: 'stream_idle_probe_attempted',
  STREAM_IDLE_PROBE_SUCCEEDED: 'stream_idle_probe_succeeded',
  CONTEXT_EXCEEDED_FAILOVER: 'context_exceeded_failover',
  CONTEXT_EXCEEDED_THROWTHROUGH: 'context_exceeded_throwthrough',
  PERMANENT_SKIP_RETRY: 'permanent_skip_retry',
  HEDGE_STARTED: 'hedge_started',
  HEDGE_PRIMARY_RECOVERED: 'hedge_primary_recovered',
  HEDGE_PRIMARY_POST_FIRST_CHUNK_FAILURE: 'hedge_primary_post_first_chunk_failure',
  HEDGE_FALLBACK_COMMITTED: 'hedge_fallback_committed',
  HEDGE_PRIMARY_SUCCEEDED_AFTER_RACE_LOST: 'hedge_primary_succeeded_after_race_lost',
  ALL_PROVIDERS_CONTEXT_EXCEEDED: 'all_providers_context_exceeded',
  RACE_LOSER_CLEANED: 'race_loser_cleaned',
  SDK_CLIENT_CACHE_HIT: 'sdk_client_cache_hit',
  SDK_CLIENT_CACHE_MISS: 'sdk_client_cache_miss',
  PROVIDER_CLOSE_FAILED: 'provider_close_failed',
  // contract 通知 / CLI co-writer / audit jobs（1）——contract_events/contract_cancelled 是
  // inbox sender type（guidanceRegistry 命名空间）、非 stream 事件（phase 1313 纠错）
  USER_NOTIFY: 'user_notify',
  // assembly daemon 启动（1）
  DAEMON_STARTED: 'daemon_started',
  // stream writer 归档（1）
  SESSION_BOUNDARY: 'session_boundary',
  // async-task-system task 生命周期（3）
  TASK_STARTED: 'task_started',
  TASK_COMPLETED: 'task_completed',
  TASK_ATTEMPT_START: 'task_attempt_start',
  // 幽灵类型（处置留后续 phase）
  USER_REPLY: 'user_reply',
} as const;

export type StreamEventType = typeof STREAM_EVENT_NAMES[keyof typeof STREAM_EVENT_NAMES];

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
export const LLM_OUTPUT_EVENTS = new Set<StreamEventType>([
  'thinking_delta', 'text_delta', 'tool_call', 'user_reply', 'user_reply_delta', 'user_reply_end',
]);
