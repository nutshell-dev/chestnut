// src/assembly/llm-audit-events.ts
/**
 * LLM Service audit event names.
 *
 * Module-owned event namespace per H1 design (phase336 / r36 α 决策 / H1 收官).
 * 字符串值与起步态 events.ts LLM_* 系列等价 / 0 漂移。
 *
 * 文件位置与 caller llm-audit-sink.ts 同目录 / phase328 历史关联。
 */
export const LLM_AUDIT_EVENTS = {
  PROVIDER_ATTEMPT_FAILED: 'llm_provider_attempt_failed',
  RETRY_SCHEDULED: 'llm_retry_scheduled',
  PROVIDER_EXHAUSTED: 'llm_provider_exhausted',
  FALLBACK_SWITCHED: 'llm_fallback_switched',
  BREAKER_OPENED: 'llm_breaker_opened',
  BREAKER_HALF_OPEN: 'llm_breaker_half_open',
  BREAKER_CLOSED: 'llm_breaker_closed',
  HEALTHCHECK_FAILED: 'llm_healthcheck_failed',
  STREAM_RESET: 'llm_stream_reset',
  STREAM_PARSE_ERROR: 'llm_stream_parse_error',
  TOOL_ARG_PARSE_ERROR: 'llm_tool_arg_parse_error',
  IDLE_FAILOVER_TRIGGERED: 'llm_idle_failover_triggered',
  STREAM_IDLE_PROBE_ATTEMPTED: 'llm_stream_idle_probe_attempted',
  STREAM_IDLE_PROBE_SUCCEEDED: 'llm_stream_idle_probe_succeeded',
  HEDGE_STARTED: 'llm.hedge.started',
  HEDGE_PRIMARY_RECOVERED: 'llm.hedge.primary_recovered',
  HEDGE_PRIMARY_POST_FIRST_CHUNK_FAILURE: 'llm.hedge.primary_post_first_chunk_failure', // phase 289 Step A
  HEDGE_FALLBACK_COMMITTED: 'llm.hedge.fallback_committed',
  HEDGE_PRIMARY_SUCCEEDED_AFTER_RACE_LOST: 'llm.hedge.primary_succeeded_after_race_lost',
  CONTEXT_EXCEEDED_FAILOVER: 'llm_context_exceeded_failover',
  CONTEXT_EXCEEDED_THROWTHROUGH: 'llm_context_exceeded_throwthrough',
  PERMANENT_SKIP_RETRY: 'llm_permanent_skip_retry',
  ALL_PROVIDERS_CONTEXT_EXCEEDED: 'llm_all_providers_context_exceeded',
  RACE_LOSER_CLEANED: 'llm_race_loser_cleaned',
  SDK_CLIENT_CACHE_HIT: 'llm_sdk_client_cache_hit',
  SDK_CLIENT_CACHE_MISS: 'llm_sdk_client_cache_miss',
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const ASSEMBLY_LLM_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  llm_provider_attempt_failed: 'audit',
  llm_retry_scheduled: 'audit',
  llm_provider_exhausted: 'audit',
  llm_fallback_switched: 'audit',
  llm_breaker_opened: 'audit',
  llm_breaker_half_open: 'audit',
  llm_breaker_closed: 'audit',
  llm_healthcheck_failed: 'audit',
  llm_stream_reset: 'audit',
  llm_stream_parse_error: 'audit',
  llm_tool_arg_parse_error: 'audit',
  llm_idle_failover_triggered: 'audit',
  llm_stream_idle_probe_attempted: 'audit',
  llm_stream_idle_probe_succeeded: 'audit',
  'llm.hedge.primary_post_first_chunk_failure': 'audit', // phase 289 Step A
  llm_context_exceeded_failover: 'audit',
  llm_context_exceeded_throwthrough: 'audit',
  llm_permanent_skip_retry: 'audit',
  llm_all_providers_context_exceeded: 'audit',
  llm_race_loser_cleaned: 'audit',
  llm_sdk_client_cache_hit: 'audit',
  llm_sdk_client_cache_miss: 'audit',
} as const;
