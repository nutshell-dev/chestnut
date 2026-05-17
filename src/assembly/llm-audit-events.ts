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
  HEDGE_FALLBACK_COMMITTED: 'llm.hedge.fallback_committed',
  HEDGE_PRIMARY_SUCCEEDED_AFTER_RACE_LOST: 'llm.hedge.primary_succeeded_after_race_lost',
  CONTEXT_EXCEEDED_FAILOVER: 'llm_context_exceeded_failover',
  PERMANENT_SKIP_RETRY: 'llm_permanent_skip_retry',
} as const;
