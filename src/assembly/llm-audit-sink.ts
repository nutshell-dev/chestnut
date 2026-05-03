import { LLM_AUDIT_EVENTS } from './llm-audit-events.js';
import type { LLMEventSink, LLMEvent } from '../foundation/llm-orchestrator/index.js';
import type { Audit } from '../foundation/audit/index.js';

export function createLLMAuditSink(audit: Audit): LLMEventSink {
  return {
    emit(event: LLMEvent): void {
      try {
        switch (event.type) {
          case 'provider_attempt_failed':
            audit.write(LLM_AUDIT_EVENTS.PROVIDER_ATTEMPT_FAILED,
              `provider=${event.provider}`, `attempt=${event.attempt}`, `error=${event.error}`);
            break;
          case 'retry_scheduled':
            audit.write(LLM_AUDIT_EVENTS.RETRY_SCHEDULED,
              `provider=${event.provider}`, `attempt=${event.attempt}`, `backoffMs=${event.backoffMs}`);
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
          case 'idle_failover_triggered':
            audit.write(
              LLM_AUDIT_EVENTS.IDLE_FAILOVER_TRIGGERED,
              `provider=${event.provider}`,
              `ms=${event.ms}`,
            );
            break;
        }
      } catch {
        // Error isolation: audit failure must not interrupt LLM path
      }
    }
  };
}
