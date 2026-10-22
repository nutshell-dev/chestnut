// phase 1872 Step H: 事件声明归 LLMOrchestrator owner——sink 只做绑定。
import { LLM_AUDIT_EVENTS } from '../foundation/llm-orchestrator/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import type { LLMEventSink, LLMEvent } from '../foundation/llm-orchestrator/index.js';
import type { AuditLog, AuditWriteOutcome } from '../foundation/audit/index.js';
import { STREAM_EVENT_NAMES } from '../foundation/stream/index.js';
import type { StreamLog, StreamEvent } from '../foundation/stream/index.js';

/**
 * phase 1765：AuditWriter/DispatchingAuditWriter 的 write 结构化返回 durability
 * outcome（AuditLog 接口面保持 void、协变拓宽合法）。mock/其他实现返回 undefined
 * 或非 outcome 值时按 durable 解释（不伪造失败）；显式非 durable / 抛错才标记。
 */
type AuditOutcomeWrite = (type: string, ...cols: (string | number)[]) => AuditWriteOutcome;

function asOutcome(v: unknown): AuditWriteOutcome | undefined {
  if (typeof v === 'object' && v !== null && 'kind' in v) return v as AuditWriteOutcome;
  return undefined;
}

export function createLLMEventSink(
  audit: AuditLog,
  stream: StreamLog,
): LLMEventSink {
  const auditWrite = audit.write.bind(audit) as unknown as AuditOutcomeWrite;
  return {
    emit(event: LLMEvent): void {
      let outcome: AuditWriteOutcome | undefined;
      let auditThrew: unknown;
      try {
        outcome = asOutcome(writeLLMAuditEvent(auditWrite, event));
      } catch (error) {
        auditThrew = error;
        // Error isolation: audit failure must not interrupt stream path or LLM path
        console.error(
          `[LLM EVENT SINK CRITICAL] audit sink emit failed: type=${event.type} reason=${formatErr(error)}`,
        );
      }

      // Phase 1968 Step B（LLM-CALL-SUCCESS-PROVENANCE-NOT-AUDITABLE）：审计持久化
      // 降级是显式可观察状态——「未写入/未落盘」不得静默当作「已审计」。写异常或非
      // durable outcome（append 失败进 fallback 池 / sync 失败）都产生显式 marker。
      if (auditThrew !== undefined || (outcome !== undefined && outcome.kind !== 'durable')) {
        reportAuditPersistenceFailure(auditWrite, stream, event, auditThrew ?? outcome);
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

/**
 * Phase 1968 Step B：审计写失败的显式暴露（不静默丢弃、不伪造已审计）。
 * - 尽力回写 audit marker：append 仍失败时进 writer fallback 池（证据不丢），不递归标记；
 * - stream.jsonl 独立通道留第二见证（audit 文件降级时仍可事后关联 invocationId）；
 * - console.error CRITICAL 保持既有告警通道。
 */
function reportAuditPersistenceFailure(
  auditWrite: AuditOutcomeWrite,
  stream: StreamLog,
  event: LLMEvent,
  cause: unknown,
): void {
  const invocationId = 'invocationId' in event && typeof event.invocationId === 'string'
    ? event.invocationId
    : undefined;
  const asOutcomeCause = asOutcome(cause);
  const reason = asOutcomeCause !== undefined
    ? `outcome=${asOutcomeCause.kind} error=${asOutcomeCause.kind === 'durable' ? 'none' : formatErr(asOutcomeCause.error)}`
    : formatErr(cause);
  try {
    auditWrite(LLM_AUDIT_EVENTS.CALL_AUDIT_WRITE_FAILED,
      `event_type=${event.type}`, `invocation=${invocationId ?? 'none'}`, `reason=${reason}`);
  } catch (markerErr) {
    // marker 回写也失败（主通道持续故障）——不递归标记，但不得静默：显式 CRITICAL。
    console.error(`[LLM EVENT SINK CRITICAL] audit-failure marker audit write failed: ${formatErr(markerErr)}`);
  }
  try {
    stream.write(toStreamEvent({
      type: STREAM_EVENT_NAMES.CALL_AUDIT_WRITE_FAILED,
      eventType: event.type,
      ...(invocationId !== undefined ? { invocationId } : {}),
      reason,
    }));
  } catch (streamErr) {
    console.error(`[LLM EVENT SINK CRITICAL] audit-failure marker stream write failed: ${formatErr(streamErr)}`);
  }
  console.error(`[LLM EVENT SINK CRITICAL] audit persistence degraded: event=${event.type} invocation=${invocationId ?? 'none'} reason=${reason}`);
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

function writeLLMAuditEvent(auditWrite: AuditOutcomeWrite, event: LLMEvent): AuditWriteOutcome | undefined {
  let outcome: AuditWriteOutcome | undefined;
  const w = (type: string, ...cols: (string | number)[]): void => {
    outcome = auditWrite(type, ...cols);
  };
  switch (event.type) {
    case 'provider_attempt_failed':
      w(LLM_AUDIT_EVENTS.PROVIDER_ATTEMPT_FAILED,
        `provider=${event.provider}`, `attempt=${event.attempt}`, `max=${event.maxAttempts}`,
        `errorClass=${event.errorClass}`, `hint=${event.userActionHint ?? 'none'}`,
        `retry_after_sec=${event.retryAfterSec ?? 'none'}`,
        `error=${event.error}`);
      break;
    case 'retry_scheduled':
      w(LLM_AUDIT_EVENTS.RETRY_SCHEDULED,
        `provider=${event.provider}`, `attempt=${event.attempt}`, `max=${event.maxAttempts}`, `backoff_ms=${event.backoffMs}`);
      break;
    case 'provider_exhausted':
      w(LLM_AUDIT_EVENTS.PROVIDER_EXHAUSTED,
        `provider=${event.provider}`, `error=${event.error}`);
      break;
    case 'fallback_switched':
      w(LLM_AUDIT_EVENTS.FALLBACK_SWITCHED,
        `from=${event.from}`, `to=${event.to}`, `reason=${event.reason}`);
      break;
    case 'breaker_opened':
      w(LLM_AUDIT_EVENTS.BREAKER_OPENED,
        `provider=${event.provider}`, `consecutiveFailures=${event.consecutiveFailures}`);
      break;
    case 'breaker_half_open':
      w(LLM_AUDIT_EVENTS.BREAKER_HALF_OPEN, `provider=${event.provider}`);
      break;
    case 'breaker_closed':
      w(LLM_AUDIT_EVENTS.BREAKER_CLOSED, `provider=${event.provider}`);
      break;
    case 'healthcheck_failed':
      w(LLM_AUDIT_EVENTS.HEALTHCHECK_FAILED,
        `provider=${event.provider}`, `error=${event.error}`);
      break;
    case 'stream_reset':
      w(LLM_AUDIT_EVENTS.STREAM_RESET,
        `provider=${event.provider}`, `error=${event.error}`);
      break;
    case 'stream_parse_error':
      w(LLM_AUDIT_EVENTS.STREAM_PARSE_ERROR,
        `provider=${event.provider}`, `raw=${event.raw}`, `error=${event.error}`);
      break;
    case 'tool_arg_parse_error':
      w(LLM_AUDIT_EVENTS.TOOL_ARG_PARSE_ERROR,
        `provider=${event.provider}`, `tool=${event.toolName}`, `raw=${event.rawArgs}`, `error=${event.error}`);
      break;
    case 'idle_failover_triggered':
      w(
        LLM_AUDIT_EVENTS.IDLE_FAILOVER_TRIGGERED,
        `provider=${event.provider}`,
        `elapsed_ms=${event.ms}`,
      );
      break;
    case 'stream_idle_probe_attempted':
      w(LLM_AUDIT_EVENTS.STREAM_IDLE_PROBE_ATTEMPTED,
        `provider=${event.provider}`, `timeout_ms=${event.timeoutMs}`);
      break;
    case 'stream_idle_probe_succeeded':
      w(LLM_AUDIT_EVENTS.STREAM_IDLE_PROBE_SUCCEEDED,
        `provider=${event.provider}`);
      break;
    case 'hedge_started':
      w(LLM_AUDIT_EVENTS.HEDGE_STARTED,
        `primary=${event.primary}`, `fallbackChain=${event.fallbackChain.join(',')}`,
        `triggerErrorClass=${event.triggerErrorClass}`);
      break;
    case 'hedge_primary_recovered':
      w(LLM_AUDIT_EVENTS.HEDGE_PRIMARY_RECOVERED, `provider=${event.provider}`,
        `cache_creation_input_tokens=${event.cacheCreationInputTokens ?? 0}`,
        `cache_read_input_tokens=${event.cacheReadInputTokens ?? 0}`);
      break;
    case 'hedge_primary_post_first_chunk_failure':
      w(
        LLM_AUDIT_EVENTS.HEDGE_PRIMARY_POST_FIRST_CHUNK_FAILURE,
        `provider=${event.provider}`,
        `error=${event.error.message}`,
      );
      break;
    case 'hedge_fallback_committed':
      w(LLM_AUDIT_EVENTS.HEDGE_FALLBACK_COMMITTED,
        `winner=${event.winnerProvider}`, `primary=${event.primaryProvider}`,
        `primaryErrorClass=${event.primaryErrorClass}`, `primaryError=${event.primaryError}`,
        `cache_creation_input_tokens=${event.cacheCreationInputTokens ?? 0}`,
        `cache_read_input_tokens=${event.cacheReadInputTokens ?? 0}`);
      break;
    case 'hedge_primary_succeeded_after_race_lost':
      w(
        LLM_AUDIT_EVENTS.HEDGE_PRIMARY_SUCCEEDED_AFTER_RACE_LOST,
        `primaryProvider=${event.primaryProvider}`,
        `winnerProvider=${event.winnerProvider}`,
      );
      break;
    case 'context_exceeded_failover':
      w(LLM_AUDIT_EVENTS.CONTEXT_EXCEEDED_FAILOVER,
        `provider=${event.provider}`, `stopReason=${event.stopReason}`);
      break;
    case 'context_exceeded_throwthrough':
      w(LLM_AUDIT_EVENTS.CONTEXT_EXCEEDED_THROWTHROUGH,
        `provider=${event.provider}`);
      break;
    case 'all_providers_context_exceeded':
      w(LLM_AUDIT_EVENTS.ALL_PROVIDERS_CONTEXT_EXCEEDED,
        `totalAttempted=${event.totalAttempted}`, `skippedCount=${event.skippedCount}`);
      break;
    case 'permanent_skip_retry':
      w(LLM_AUDIT_EVENTS.PERMANENT_SKIP_RETRY,
        `provider=${event.provider}`, `attempt=${event.attempt}`, `errorClass=${event.errorClass}`);
      break;
    case 'race_loser_cleaned':
      w(LLM_AUDIT_EVENTS.RACE_LOSER_CLEANED,
        `provider=${event.provider}`, `reason=${event.reason}`);
      break;
    case 'sdk_client_cache_hit':
      w(LLM_AUDIT_EVENTS.SDK_CLIENT_CACHE_HIT,
        `preset=${event.preset}`, `model=${event.model}`);
      break;
    case 'sdk_client_cache_miss':
      w(LLM_AUDIT_EVENTS.SDK_CLIENT_CACHE_MISS,
        `preset=${event.preset}`, `model=${event.model}`);
      break;
    case 'recovery_facts_accepted':
      // phase 1827: 完整新事实接受证据（多事实不互相遮蔽）；磁盘接受记录仍是证据权威。
      w(LLM_AUDIT_EVENTS.RECOVERY_FACTS_ACCEPTED,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `interventions=${event.interventionIds.join(',') || 'none'}`,
        `config=${event.configurationRevision ?? 'none'}`,
        `startup=${event.startupId ?? 'none'}`,
        `attempt=${event.attemptId ?? 'none'}`);
      break;
    // phase 1953: 恢复决定链进 audit——此前这些事件只进 stream.jsonl，audit 侧无法
    // 重建「失败→安排→准入→就绪」迁移；revision 与 recovery-state 磁盘 revision 对齐。
    case 'recovery_scheduled':
      w(LLM_AUDIT_EVENTS.RECOVERY_SCHEDULED,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `scheduleKind=${event.scheduleKind}`,
        `resumeAt=${event.resumeAt || 'none'}`,
        `errorClass=${event.errorClass}`,
        `providerCount=${event.providerCount}`,
        `failureCount=${event.failureCount}`);
      break;
    case 'recovery_ready':
      w(LLM_AUDIT_EVENTS.RECOVERY_READY,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `reason=${event.reason}`);
      break;
    case 'recovery_attempt_admitted':
      w(LLM_AUDIT_EVENTS.RECOVERY_ATTEMPT_ADMITTED,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `attempt=${event.attemptId}`,
        `trigger=${event.trigger}`,
        `interventions=${event.interventionCount}`);
      break;
    case 'recovery_attempt_finished':
      w(LLM_AUDIT_EVENTS.RECOVERY_ATTEMPT_FINISHED,
        `scope=${event.scope}`, `revision=${event.revision}`,
        `attempt=${event.attemptId}`,
        `outcome=${event.outcome}`,
        `accepted=${event.accepted}`);
      break;
    case 'recovery_state_write_failed':
      w(LLM_AUDIT_EVENTS.RECOVERY_STATE_WRITE_FAILED,
        `scope=${event.scope}`,
        `context=${event.context}`,
        `reason=${event.reason}`);
      break;
    // Phase 1968 Step B：provider 调用路径审计（invocation/attempt/selection）。
    case 'call_invocation_started':
      w(LLM_AUDIT_EVENTS.CALL_INVOCATION_STARTED,
        `invocation=${event.invocationId}`, `kind=${event.kind}`, `config_rev=${event.configRevision}`,
        `candidates=${event.candidates.map(c => `${c.name}:${c.providerId}`).join(',')}`);
      break;
    case 'call_attempt_result':
      w(LLM_AUDIT_EVENTS.CALL_ATTEMPT_RESULT,
        `invocation=${event.invocationId}`, `attempt_index=${event.attemptIndex}`,
        `provider=${event.provider}`, `provider_id=${event.providerId}`, `outcome=${event.outcome}`,
        `error_class=${event.errorClass ?? 'none'}`, `reason=${event.reason ?? 'none'}`,
        `error=${event.error ?? 'none'}`);
      break;
    case 'call_selection':
      w(LLM_AUDIT_EVENTS.CALL_SELECTION,
        `invocation=${event.invocationId}`, `outcome=${event.outcome}`,
        `provider=${event.provider ?? 'none'}`, `provider_id=${event.providerId ?? 'none'}`,
        `attempt_index=${event.attemptIndex ?? 'none'}`);
      break;
    // 由本 sink 在审计持久化降级时直接写（LLMOrchestrator 不产生）；case 备完整性。
    case 'call_audit_write_failed':
      w(LLM_AUDIT_EVENTS.CALL_AUDIT_WRITE_FAILED,
        `event_type=${event.eventType}`, `invocation=${event.invocationId ?? 'none'}`,
        `reason=${event.reason}`);
      break;
  }
  return outcome;
}

