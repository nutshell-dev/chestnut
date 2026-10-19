// phase 1872 Step H: 事件声明归 LLMOrchestrator owner——sink 只做绑定。
import { LLM_AUDIT_EVENTS } from '../foundation/llm-orchestrator/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import type { LLMEventSink, LLMEvent } from '../foundation/llm-orchestrator/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { StreamLog, StreamEvent } from '../foundation/stream/index.js';

export function createLLMEventSink(
  audit: AuditLog,
  stream: StreamLog,
): LLMEventSink {
  return {
    emit(event: LLMEvent): void {
        try {
        writeLLMAuditEvent(audit, event);
      } catch (error) {
        // Error isolation: audit failure must not interrupt stream path or LLM path
        console.error(
          `[LLM EVENT SINK CRITICAL] audit sink emit failed: type=${event.type} reason=${formatErr(error)}`,
        );
      }

      try {
        stream.write(toStreamEvent(event));
      } catch (error) {
        // Error isolation: stream failure must not interrupt audit path or LLM path
        console.error(
          `[LLM EVENT SINK CRITICAL] stream sink emit failed: type=${event.type} reason=${formatErr(error)}`,
        );
      }
    },
  };
}

function toStreamEvent(event: LLMEvent): StreamEvent {
  const normalizedError =
    'error' in event && event.error instanceof Error
      ? formatErr(event.error)
      : ('error' in event ? event.error : undefined);
  return {
    ts: Date.now(),
    ...event,
    ...('error' in event ? { error: normalizedError } : {}),
  } as StreamEvent;
}

function writeLLMAuditEvent(audit: AuditLog, event: LLMEvent): void {
  switch (event.type) {
    case 'provider_attempt_failed':
      audit.write(LLM_AUDIT_EVENTS.PROVIDER_ATTEMPT_FAILED,
        `provider=${event.provider}`, `attempt=${event.attempt}`, `max=${event.maxAttempts}`,
        `errorClass=${event.errorClass}`, `hint=${event.userActionHint ?? 'none'}`,
        `retry_after_sec=${event.retryAfterSec ?? 'none'}`,
        `error=${event.error}`);
      break;
    case 'retry_scheduled':
      audit.write(LLM_AUDIT_EVENTS.RETRY_SCHEDULED,
        `provider=${event.provider}`, `attempt=${event.attempt}`, `max=${event.maxAttempts}`, `backoff_ms=${event.backoffMs}`);
      break;
    case 'provider_exhausted':
      audit.write(LLM_AUDIT_EVENTS.PROVIDER_EXHAUSTED,
        `provider=${event.provider}`, `error=${event.error}`);
      break;
    case 'fallback_switched':
      audit.write(LLM_AUDIT_EVENTS.FALLBACK_SWITCHED,
        `from=${event.from}`, `to=${event.to}`, `reason=${event.reason}`);
      break;
    case 'breaker_opened':
      audit.write(LLM_AUDIT_EVENTS.BREAKER_OPENED,
        `provider=${event.provider}`, `consecutiveFailures=${event.consecutiveFailures}`);
      break;
    case 'breaker_half_open':
      audit.write(LLM_AUDIT_EVENTS.BREAKER_HALF_OPEN, `provider=${event.provider}`);
      break;
    case 'breaker_closed':
      audit.write(LLM_AUDIT_EVENTS.BREAKER_CLOSED, `provider=${event.provider}`);
      break;
    case 'healthcheck_failed':
      audit.write(LLM_AUDIT_EVENTS.HEALTHCHECK_FAILED,
        `provider=${event.provider}`, `error=${event.error}`);
      break;
    case 'stream_reset':
      audit.write(LLM_AUDIT_EVENTS.STREAM_RESET,
        `provider=${event.provider}`, `error=${event.error}`);
      break;
    case 'stream_parse_error':
      audit.write(LLM_AUDIT_EVENTS.STREAM_PARSE_ERROR,
        `provider=${event.provider}`, `raw=${event.raw}`, `error=${event.error}`);
      break;
    case 'tool_arg_parse_error':
      audit.write(LLM_AUDIT_EVENTS.TOOL_ARG_PARSE_ERROR,
        `provider=${event.provider}`, `tool=${event.toolName}`, `raw=${event.rawArgs}`, `error=${event.error}`);
      break;
    case 'idle_failover_triggered':
      audit.write(
        LLM_AUDIT_EVENTS.IDLE_FAILOVER_TRIGGERED,
        `provider=${event.provider}`,
        `elapsed_ms=${event.ms}`,
      );
      break;
    case 'stream_idle_probe_attempted':
      audit.write(LLM_AUDIT_EVENTS.STREAM_IDLE_PROBE_ATTEMPTED,
        `provider=${event.provider}`, `timeout_ms=${event.timeoutMs}`);
      break;
    case 'stream_idle_probe_succeeded':
      audit.write(LLM_AUDIT_EVENTS.STREAM_IDLE_PROBE_SUCCEEDED,
        `provider=${event.provider}`);
      break;
    case 'hedge_started':
      audit.write(LLM_AUDIT_EVENTS.HEDGE_STARTED,
        `primary=${event.primary}`, `fallbackChain=${event.fallbackChain.join(',')}`,
        `triggerErrorClass=${event.triggerErrorClass}`);
      break;
    case 'hedge_primary_recovered':
      audit.write(LLM_AUDIT_EVENTS.HEDGE_PRIMARY_RECOVERED, `provider=${event.provider}`,
        `cache_creation_input_tokens=${event.cacheCreationInputTokens ?? 0}`,
        `cache_read_input_tokens=${event.cacheReadInputTokens ?? 0}`);
      break;
    case 'hedge_primary_post_first_chunk_failure':
      audit.write(
        LLM_AUDIT_EVENTS.HEDGE_PRIMARY_POST_FIRST_CHUNK_FAILURE,
        `provider=${event.provider}`,
        `error=${event.error.message}`,
      );
      break;
    case 'hedge_fallback_committed':
      audit.write(LLM_AUDIT_EVENTS.HEDGE_FALLBACK_COMMITTED,
        `winner=${event.winnerProvider}`, `primary=${event.primaryProvider}`,
        `primaryErrorClass=${event.primaryErrorClass}`, `primaryError=${event.primaryError}`,
        `cache_creation_input_tokens=${event.cacheCreationInputTokens ?? 0}`,
        `cache_read_input_tokens=${event.cacheReadInputTokens ?? 0}`);
      break;
    case 'hedge_primary_succeeded_after_race_lost':
      audit.write(
        LLM_AUDIT_EVENTS.HEDGE_PRIMARY_SUCCEEDED_AFTER_RACE_LOST,
        `primaryProvider=${event.primaryProvider}`,
        `winnerProvider=${event.winnerProvider}`,
      );
      break;
    case 'context_budget_warning':
      audit.write(LLM_AUDIT_EVENTS.CONTEXT_BUDGET_WARNING,
        `provider=${event.provider}`,
        `estimated_tokens=${event.estimatedTokens}`,
        `context_window=${event.contextWindow}`,
        `ratio=${event.ratio.toFixed(3)}`);
      break;
    case 'context_exceeded_failover':
      audit.write(LLM_AUDIT_EVENTS.CONTEXT_EXCEEDED_FAILOVER,
        `provider=${event.provider}`, `stopReason=${event.stopReason}`);
      break;
    case 'context_exceeded_throwthrough':
      audit.write(LLM_AUDIT_EVENTS.CONTEXT_EXCEEDED_THROWTHROUGH,
        `provider=${event.provider}`);
      break;
    case 'all_providers_context_exceeded':
      audit.write(LLM_AUDIT_EVENTS.ALL_PROVIDERS_CONTEXT_EXCEEDED,
        `totalAttempted=${event.totalAttempted}`, `skippedCount=${event.skippedCount}`);
      break;
    case 'permanent_skip_retry':
      audit.write(LLM_AUDIT_EVENTS.PERMANENT_SKIP_RETRY,
        `provider=${event.provider}`, `attempt=${event.attempt}`, `errorClass=${event.errorClass}`);
      break;
    case 'race_loser_cleaned':
      audit.write(LLM_AUDIT_EVENTS.RACE_LOSER_CLEANED,
        `provider=${event.provider}`, `reason=${event.reason}`);
      break;
    case 'sdk_client_cache_hit':
      audit.write(LLM_AUDIT_EVENTS.SDK_CLIENT_CACHE_HIT,
        `preset=${event.preset}`, `model=${event.model}`);
      break;
    case 'sdk_client_cache_miss':
      audit.write(LLM_AUDIT_EVENTS.SDK_CLIENT_CACHE_MISS,
        `preset=${event.preset}`, `model=${event.model}`);
      break;
    case 'recovery_facts_accepted':
      // phase 1827: 完整新事实接受证据（多事实不互相遮蔽）；磁盘接受记录仍是证据权威。
      audit.write(LLM_AUDIT_EVENTS.RECOVERY_FACTS_ACCEPTED,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `interventions=${event.interventionIds.join(',') || 'none'}`,
        `config=${event.configurationRevision ?? 'none'}`,
        `startup=${event.startupId ?? 'none'}`,
        `attempt=${event.attemptId ?? 'none'}`);
      break;
    // phase 1953: 恢复决定链进 audit——此前这些事件只进 stream.jsonl，audit 侧无法
    // 重建「失败→安排→准入→就绪」迁移；revision 与 recovery-state 磁盘 revision 对齐。
    case 'recovery_scheduled':
      audit.write(LLM_AUDIT_EVENTS.RECOVERY_SCHEDULED,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `scheduleKind=${event.scheduleKind}`,
        `resumeAt=${event.resumeAt || 'none'}`,
        `errorClass=${event.errorClass}`,
        `providerCount=${event.providerCount}`,
        `failureCount=${event.failureCount}`);
      break;
    case 'recovery_ready':
      audit.write(LLM_AUDIT_EVENTS.RECOVERY_READY,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `reason=${event.reason}`);
      break;
    case 'recovery_attempt_admitted':
      audit.write(LLM_AUDIT_EVENTS.RECOVERY_ATTEMPT_ADMITTED,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `attempt=${event.attemptId}`,
        `trigger=${event.trigger}`,
        `interventions=${event.interventionCount}`);
      break;
    case 'recovery_attempt_finished':
      audit.write(LLM_AUDIT_EVENTS.RECOVERY_ATTEMPT_FINISHED,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `attempt=${event.attemptId}`,
        `outcome=${event.outcome}`,
        `accepted=${event.accepted}`);
      break;
    case 'recovery_state_write_failed':
      audit.write(LLM_AUDIT_EVENTS.RECOVERY_STATE_WRITE_FAILED,
        `scope=${event.scope}`,
        `context=${event.context}`,
        `reason=${event.reason}`);
      break;
  }
}

