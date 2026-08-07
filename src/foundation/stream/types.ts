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
  // system_notify（1）：系统/契约侧主动通知用户（subtype 区分 contract_created 等）；
  // 曾名 user_notify（2026-08-07 phase 1319 改名——user_ 前缀族语义为「用户来源」、此事件是「通知用户」接收方、命名歧义治理）
  SYSTEM_NOTIFY: 'system_notify',
  // assembly daemon 启动（1）
  DAEMON_STARTED: 'daemon_started',
  // stream writer 归档（1）
  SESSION_BOUNDARY: 'session_boundary',
  // async-task-system task 生命周期（3）
  TASK_STARTED: 'task_started',
  TASK_COMPLETED: 'task_completed',
  TASK_ATTEMPT_START: 'task_attempt_start',
} as const;

export type StreamEventType = typeof STREAM_EVENT_NAMES[keyof typeof STREAM_EVENT_NAMES];

/**
 * stream.jsonl 事件 payload 判别映射（phase 1316）。
 * payload 权威双份策略：LLMEvent 27 个的 payload 在此重定义（orchestrator 特有类型降级）；
 * 漂移由编译互检 + 契约测试兜底。非 LLMEvent 23 个以写端对象字面量为准。
 * 全部成员含 trace_id?: string，因为 stream-callbacks checkWrite 可能注入 trace_id。
 */
interface StreamEventMap {
  // agent-executor（13）
  turn_start: { sources?: Array<{ text: string; type: string }>; trace_id?: string };
  llm_start: { trace_id?: string };
  thinking_delta: { delta: string; trace_id?: string };
  text_delta: { delta: string; trace_id?: string };
  text_end: { trace_id?: string };
  tool_call: { name: string; tool_use_id: string; trace_id?: string };
  tool_use_input: { name: string; tool_use_id: string; input: Record<string, unknown>; trace_id?: string };
  user_reply_delta: { delta: string; trace_id?: string };
  user_reply_end: { trace_id?: string };
  tool_result: { name: string; tool_use_id: string; success: boolean; summary: string; step: number; maxSteps: number; trace_id?: string };
  turn_end: { trace_id?: string };
  turn_interrupted: { cause: string; message?: string; trace_id?: string };
  turn_error: { error: string; trace_id?: string };
  // agent-executor stream-callbacks 裸字面量（3）
  provider_info: { name: string; model: string; isFallback: boolean; trace_id?: string };
  provider_failover: { from: string; timeoutMs: number; trace_id?: string };
  provider_failed: { provider: string; model: string; error: string; trace_id?: string };
  // event-loop（1）
  llm_retry_waiting: { stage: 'retry' | 'cooldown'; action: 'scheduled' | 'gated' | 'released'; attempt: number; maxAttempts: number; delayMs: number; resumeAt: string; errorClass: string; trace_id?: string };
  // llm-orchestrator LLMEvent（27，payload 重定义、orchestrator 特有类型降级）
  provider_attempt_failed: { provider: string; attempt: number; maxAttempts: number; error: string; errorClass: string; userActionHint: string; retryAfterSec?: number; trace_id?: string };
  retry_scheduled: { provider: string; attempt: number; maxAttempts: number; backoffMs: number; trace_id?: string };
  provider_exhausted: { provider: string; error: string; trace_id?: string };
  fallback_switched: { from: string; to: string; reason: string; trace_id?: string };
  breaker_opened: { provider: string; consecutiveFailures: number; trace_id?: string };
  breaker_half_open: { provider: string; trace_id?: string };
  breaker_closed: { provider: string; trace_id?: string };
  healthcheck_failed: { provider: string; error: string; trace_id?: string };
  stream_reset: { provider: string; error: string; trace_id?: string };
  stream_parse_error: { provider: string; raw: string; error: string; trace_id?: string };
  tool_arg_parse_error: { provider: string; toolName: string; rawArgs: string; error: string; trace_id?: string };
  idle_failover_triggered: { provider: string; ms: number; trace_id?: string };
  stream_idle_probe_attempted: { provider: string; timeoutMs: number; trace_id?: string };
  stream_idle_probe_succeeded: { provider: string; trace_id?: string };
  context_exceeded_failover: { provider: string; stopReason: string; trace_id?: string };
  context_exceeded_throwthrough: { provider: string; trace_id?: string };
  permanent_skip_retry: { provider: string; attempt: number; errorClass: string; trace_id?: string };
  hedge_started: { primary: string; fallbackChain: string[]; triggerErrorClass: string; trace_id?: string };
  hedge_primary_recovered: { provider: string; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; trace_id?: string };
  hedge_primary_post_first_chunk_failure: { provider: string; error: string; trace_id?: string };
  hedge_fallback_committed: { winnerProvider: string; primaryProvider: string; primaryError: string; primaryErrorClass: string; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; trace_id?: string };
  hedge_primary_succeeded_after_race_lost: { primaryProvider: string; winnerProvider: string; trace_id?: string };
  all_providers_context_exceeded: { totalAttempted: number; skippedCount: number; trace_id?: string };
  race_loser_cleaned: { provider: string; reason: string; trace_id?: string };
  sdk_client_cache_hit: { preset: string; model: string; trace_id?: string };
  sdk_client_cache_miss: { preset: string; model: string; trace_id?: string };
  provider_close_failed: { error: string; trace_id?: string };
  // system_notify（1，边界 co-writer 宽松契约）
  system_notify: { subtype: string; [key: string]: unknown };
  // assembly（1）
  daemon_started: { clawId: string; pid: number; trace_id?: string };
  // stream writer（1）
  session_boundary: { reason: string; trace_id?: string };
  // async-task-system task 生命周期（3）
  task_started: { taskId: string; taskKind: string; silent: boolean; fullTaskId?: string; command?: string; startedAt?: number; trace_id?: string };
  task_attempt_start: { taskId: string; trace_id?: string };
  task_completed: { taskId: string; trace_id?: string };
}

/**
 * StreamEvent 判别联合：type 判别键 + payload + ts。
 * 消费者 switch(event.type) 分支内 payload 自动类型安全。
 */
export type StreamEvent = {
  [K in StreamEventType]: { type: K; ts: number } & StreamEventMap[K];
}[StreamEventType];

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
  'thinking_delta', 'text_delta', 'tool_call', 'user_reply_delta', 'user_reply_end',
]);
