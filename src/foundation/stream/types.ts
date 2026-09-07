/**
 * Stream module types (L2)
 */

/**
 * stream.jsonl 相对路径常量
 */
export const STREAM_FILE = 'stream.jsonl';

/**
 * stream.jsonl type 权威单源 const（phase 1312 治理；phase 1321 分层收窄 50→40）。
 * StreamEventType 由本 const 派生（typeof）→ 值集合 0 漂移。
 * 本 const 只含协议层事件（40）：LLM 输出 7 + LLM 调用调度/呈现 4 + llm-orchestrator LLMEvent 27
 * + 通用系统通知通道 1 + stream 自身 1。上层业务事件 const 归各语义模块（phase 1321 分层拆件，
 * 修复 M#1/M#3/M#5——stream 不再为不属于自己的业务语义负责）：
 *   - subagent SUBAGENT_EVENTS（6：turn_start/llm_start/tool_result/turn_end/turn_interrupted/turn_error；phase 1789 自 agent-executor 迁回语义 owner）
 *   - async-task-system STREAM_TASK_EVENTS（3：task_started/task_completed/task_attempt_start）
 *   - assembly ASSEMBLY_STREAM_EVENTS（1：daemon_started）
 * 写端一律引用 STREAM_EVENT_NAMES.X（禁裸字面量）；新增协议层事件类型先加此 const。
 */
export const STREAM_EVENT_NAMES = {
  // LLM 输出（7，L1 LLMProvider 协议层——工具调用 input 流也是 LLM 输出的一部分）。
  // send_content_* 曾名 user_reply_*（2026-08-07 phase 1321 改名消歧：user_ 前缀族语义为
  // 「用户来源」，而此事件是 send 工具 input 的 LLM 生成内容流、非用户来源事件）。
  THINKING_DELTA: 'thinking_delta',
  TEXT_DELTA: 'text_delta',
  TEXT_END: 'text_end',
  TOOL_CALL: 'tool_call',
  TOOL_USE_INPUT: 'tool_use_input',
  SEND_CONTENT_DELTA: 'send_content_delta',
  SEND_CONTENT_END: 'send_content_end',
  // LLM 调用调度/呈现（4；写端在 event-loop（L5）只是装配位置、语义属 LLM 协议层）
  PROVIDER_INFO: 'provider_info',
  PROVIDER_FAILOVER: 'provider_failover',
  PROVIDER_FAILED: 'provider_failed',
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
  // 通用系统通知通道（1）：系统/契约侧主动通知用户（subtype 区分 contract_created 等）；
  // 曾名 user_notify（2026-08-07 phase 1319 改名——user_ 前缀族语义为「用户来源」、此事件是「通知用户」接收方、命名歧义治理）。
  // 归协议层另因：写端跨 L2-L6，L2 写端（audit-size-monitor）引用上层 const 会反向依赖违规；
  // 业务语义在 subtype payload（与 session_boundary 同性质）。
  SYSTEM_NOTIFY: 'system_notify',
  // stream writer 归档（1，stream 自身）
  SESSION_BOUNDARY: 'session_boundary',
} as const;

export type StreamEventType = typeof STREAM_EVENT_NAMES[keyof typeof STREAM_EVENT_NAMES];

/**
 * stream.jsonl 协议层事件 payload 判别映射（40 key，phase 1316；phase 1321 收窄）。
 * payload 权威双份策略：LLMEvent 27 个的 payload 在此重定义（orchestrator 特有类型降级）；
 * 漂移由编译互检 + 契约测试兜底。非 LLMEvent 13 个以写端对象字面量为准。
 * 全部成员含 trace_id?: string，因为 stream-callbacks checkWrite 可能注入 trace_id。
 * 上层 10 事件（agent 6 / task 3 / daemon 1）的 payload 判别归 CLI 汇总
 * （cli/commands/stream-event-types.ts 的 UpperPayloadMap）。
 */
export interface StreamEventMap {
  // LLM 输出（7）
  thinking_delta: { delta: string; trace_id?: string };
  text_delta: { delta: string; trace_id?: string };
  text_end: { trace_id?: string };
  tool_call: { name: string; tool_use_id: string; trace_id?: string };
  tool_use_input: { name: string; tool_use_id: string; input: Record<string, unknown>; trace_id?: string };
  send_content_delta: { delta: string; trace_id?: string };
  send_content_end: { trace_id?: string };
  // LLM 调用调度/呈现（4）
  provider_info: { name: string; model: string; isFallback: boolean; trace_id?: string };
  provider_failover: { from: string; timeoutMs: number; trace_id?: string };
  provider_failed: { provider: string; model: string; error: string; trace_id?: string };
  llm_retry_waiting: { stage: 'retry' | 'cooldown'; action: 'scheduled' | 'gated' | 'released' | 'notice'; attempt: number; maxAttempts: number; delayMs: number; resumeAt: string; errorClass: string; trace_id?: string };
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
  // stream writer（1）
  session_boundary: { reason: string; trace_id?: string };
}

/**
 * stream.jsonl 事件（协议基础形态，phase 1321 诚实化）。
 * reader/writer 只保证 ts + type 存在（读 JSON 行的真实边界）；
 * 全量判别联合（含上层事件 payload）归消费端汇总（cli/commands/stream-event-types.ts）。
 */
export interface StreamEvent {
  ts: number;
  type: string;
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
 * ReadonlySet<string>：成员值是协议层字面量，但 has() 接受任意 string（reader 读出的事件
 * type 是宽松 string、含上层事件——phase 1321 StreamEvent 诚实化）。
 */
export const LLM_OUTPUT_EVENTS: ReadonlySet<string> = new Set([
  'thinking_delta', 'text_delta', 'tool_call', 'send_content_delta', 'send_content_end',
]);
