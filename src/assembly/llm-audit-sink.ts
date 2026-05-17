import { LLM_AUDIT_EVENTS } from './llm-audit-events.js';
import type { LLMEventSink, LLMEvent } from '../foundation/llm-orchestrator/index.js';
import type { AuditLog } from '../foundation/audit/index.js';

export function createLLMAuditSink(audit: AuditLog): LLMEventSink {
  return {
    emit(event: LLMEvent): void {
      try {
        switch (event.type) {
          case 'provider_attempt_failed':
            audit.write(LLM_AUDIT_EVENTS.PROVIDER_ATTEMPT_FAILED,
              `provider=${event.provider}`, `attempt=${event.attempt}`,
              `errorClass=${event.errorClass}`, `hint=${event.userActionHint ?? 'none'}`,
              `error=${event.error}`);
            break;
          case 'retry_scheduled':
            audit.write(LLM_AUDIT_EVENTS.RETRY_SCHEDULED,
              `provider=${event.provider}`, `attempt=${event.attempt}`, `backoff_ms=${event.backoffMs}`);
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
            audit.write(LLM_AUDIT_EVENTS.HEDGE_PRIMARY_RECOVERED, `provider=${event.provider}`);
            break;
          case 'hedge_fallback_committed':
            audit.write(LLM_AUDIT_EVENTS.HEDGE_FALLBACK_COMMITTED,
              `winner=${event.winnerProvider}`, `primary=${event.primaryProvider}`,
              `primaryErrorClass=${event.primaryErrorClass}`, `primaryError=${event.primaryError}`);
            break;
          case 'hedge_primary_succeeded_after_race_lost':
            audit.write(
              LLM_AUDIT_EVENTS.HEDGE_PRIMARY_SUCCEEDED_AFTER_RACE_LOST,
              `primaryProvider=${event.primaryProvider}`,
              `winnerProvider=${event.winnerProvider}`,
            );
            break;
          case 'context_exceeded_failover':
            audit.write(LLM_AUDIT_EVENTS.CONTEXT_EXCEEDED_FAILOVER,
              `provider=${event.provider}`, `stopReason=${event.stopReason}`);
            break;
          case 'permanent_skip_retry':
            audit.write(LLM_AUDIT_EVENTS.PERMANENT_SKIP_RETRY,
              `provider=${event.provider}`, `attempt=${event.attempt}`, `errorClass=${event.errorClass}`);
            break;
        }
      } catch (err) {
        // Error isolation: audit failure must not interrupt LLM path
        // dev 可见性 fallback (phase 604 / 同 phase 586 [AUDIT CRITICAL] 模板 align)
        console.error(
          `[LLM AUDIT SINK CRITICAL] sink emit failed: type=${event.type} reason=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
}
