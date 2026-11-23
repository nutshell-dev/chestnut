import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLLMEventSink } from '../../src/assembly/llm-event-sink.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { StreamLog } from '../../src/foundation/stream/index.js';
import type { LLMEvent } from '../../src/foundation/llm-orchestrator/index.js';

function makeAudit(): AuditLog & { writes: unknown[][] } {
  const writes: unknown[][] = [];
  return {
    writes,
    write: (...args: unknown[]) => writes.push(args),
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
}

function makeStream(): StreamLog & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    write: (event: unknown) => events.push(event),
  };
}

const HISTORICAL_HASH = 'a'.repeat(64);
const NO_ARTIFACT_AUDIT_COLUMNS = [
  'artifact_id=none', 'artifact_status=none', 'artifact_schema=none',
  'artifact_hash_alg=none', 'artifact_hash=none', 'artifact_bytes=none',
  'redaction_policy=none', 'artifact_reason=none',
];

function expectStreamFacts(streamEvents: unknown[], before: LLMEvent[]): void {
  expect(streamEvents).toHaveLength(before.length);
  for (const [index, item] of streamEvents.entries()) {
    const { ts, ...fact } = item as Record<string, unknown>;
    expect(ts).toEqual(expect.any(Number));
    expect(fact).toStrictEqual(before[index]);
    expect(JSON.parse(JSON.stringify(fact))).toStrictEqual(before[index]);
  }
}

describe('llm-event-sink (phase 1176 Step B)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fans out provider_attempt_failed to both audit and stream with field fidelity', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    const event: LLMEvent = {
      type: 'provider_attempt_failed',
      provider: 'anthropic',
      attempt: 3,
      maxAttempts: 4,
      error: '401 auth failed',
      errorClass: 'permanent',
      userActionHint: 'rotate_api_key',
    };

    sink.emit(event);

    expect(audit.writes).toHaveLength(1);
    expect(audit.writes[0][0]).toBe('llm_provider_attempt_failed');
    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'provider=anthropic',
      'attempt=3',
      'max=4',
      'errorClass=permanent',
      'hint=rotate_api_key',
      'retry_after_sec=none',
      'error=401 auth failed',
    ]));

    expect(stream.events).toHaveLength(1);
    const streamEvent = stream.events[0] as Record<string, unknown>;
    expect(streamEvent.type).toBe('provider_attempt_failed');
    expect(streamEvent.provider).toBe('anthropic');
    expect(streamEvent.attempt).toBe(3);
    expect(streamEvent.maxAttempts).toBe(4);
    expect(streamEvent.error).toBe('401 auth failed');
    expect(streamEvent.errorClass).toBe('permanent');
    expect(streamEvent.userActionHint).toBe('rotate_api_key');
    expect(streamEvent.retryAfterSec).toBeUndefined();  // 普通 error 不出现 retryAfter
    expect(streamEvent.ts).toEqual(expect.any(Number));
  });

  it('fans out retryAfterSec to audit and stream when present (phase 1268 Step C)', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'provider_attempt_failed',
      provider: 'openai',
      attempt: 1,
      maxAttempts: 3,
      error: '429 rate limited',
      errorClass: 'rate_limit',
      userActionHint: 'wait_retry_after',
      retryAfterSec: 42,
    });

    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'provider=openai',
      'attempt=1',
      'max=3',
      'retry_after_sec=42',
    ]));
    const streamEvent = stream.events[0] as Record<string, unknown>;
    expect(streamEvent.retryAfterSec).toBe(42);
    expect(streamEvent.maxAttempts).toBe(3);
  });

  it('still writes stream when audit.write throws', () => {
    const audit: AuditLog = {
      write: () => { throw new Error('audit fs full'); },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    sink.emit({
      type: 'provider_attempt_failed',
      provider: 'openai',
      attempt: 1,
      maxAttempts: 3,
      error: 'boom',
      errorClass: 'transient',
      userActionHint: 'retry',
    });

    // Phase 1968 Step B：审计写失败不再静默——除原事件仍写 stream 外，另写显式
    // llm_call_audit_write_failed marker（stream 独立通道），并尽力回写 audit
    // （本例 audit mock 恒抛、marker 回写也被吸收，不扩散）。
    expect(stream.events).toHaveLength(2);
    expect(stream.events[0]).toMatchObject({
      type: 'call_audit_write_failed',
      eventType: 'provider_attempt_failed',
    });
    expect(stream.events[1]).toMatchObject({ type: 'provider_attempt_failed' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[LLM EVENT SINK CRITICAL\]\s*audit/));

    consoleSpy.mockRestore();
  });

  it('still writes audit when stream.write throws', () => {
    const audit = makeAudit();
    const stream: StreamLog = {
      write: () => { throw new Error('stream locked'); },
    };
    const sink = createLLMEventSink(audit, stream);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    sink.emit({
      type: 'retry_scheduled',
      provider: 'openai',
      attempt: 2,
      maxAttempts: 3,
      backoffMs: 1000,
    });

    expect(audit.writes).toHaveLength(1);
    expect(audit.writes[0][0]).toBe('llm_retry_scheduled');
    expect(audit.writes[0]).toEqual(expect.arrayContaining(['attempt=2', 'max=3', 'backoff_ms=1000']));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[LLM EVENT SINK CRITICAL\]\s*stream/));

    consoleSpy.mockRestore();
  });

  it('fans out recovery_facts_accepted with full facts to audit and stream (phase 1827)', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    const event: LLMEvent = {
      type: 'recovery_facts_accepted',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-9',
      revision: 7,
      interventionIds: ['m1', 'm2'],
      configurationRevision: 'r-fixed',
      startupId: 'boot-1',
      attemptId: 'att-9',
    };
    sink.emit(event);

    expect(audit.writes).toHaveLength(1);
    expect(audit.writes[0][0]).toBe('llm_recovery_facts_accepted');
    expect(audit.writes[0]).toEqual([
      'llm_recovery_facts_accepted',
      'instance=owner-1',
      'invocation=inv-9',
      'revision=7',
      'interventions=m1,m2',
      'config=r-fixed',
      'startup=boot-1',
      'attempt=att-9',
    ]);

    expect(stream.events).toHaveLength(1);
    const streamEvent = stream.events[0] as Record<string, unknown>;
    expect(streamEvent.type).toBe('recovery_facts_accepted');
    expect(streamEvent.interventionIds).toEqual(['m1', 'm2']);
    expect(streamEvent.configurationRevision).toBe('r-fixed');
    expect(streamEvent.startupId).toBe('boot-1');
    expect(streamEvent.attemptId).toBe('att-9');
  });

  // ---------------------------------------------------------------------------
  // Phase 1953: 恢复决定链事件进 audit（此前只进 stream.jsonl，audit 侧无法重建迁移）
  // ---------------------------------------------------------------------------

  it('fans out recovery decision chain events to audit with revision anchor (phase 1953)', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'recovery_scheduled',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-1',
      attemptId: 'att-0',
      revision: 12,
      scheduleKind: 'at',
      resumeAt: '2026-10-19T06:00:00.000Z',
      errorClass: 'rate_limit',
      providerCount: 2,
      failureCount: 3,
    });
    sink.emit({
      type: 'recovery_attempt_admitted',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-1',
      revision: 13,
      attemptId: 'att-1',
      trigger: 'user_message',
      interventionCount: 1,
    });
    sink.emit({
      type: 'recovery_attempt_finished',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-1',
      revision: 14,
      attemptId: 'att-1',
      outcome: 'completed',
      accepted: true,
    });
    sink.emit({
      type: 'recovery_ready',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-1',
      attemptId: 'att-1',
      revision: 14,
      reason: 'success',
    });
    sink.emit({
      type: 'recovery_state_write_failed',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-1',
      attemptId: 'att-1',
      reason: 'ENOSPC',
      context: 'noteFailure',
    });

    expect(audit.writes).toHaveLength(5);
    expect(audit.writes[0]).toEqual([
      'llm_recovery_scheduled',
      'instance=owner-1',
      'invocation=inv-1',
      'attempt=att-0',
      'revision=12',
      'scheduleKind=at',
      'resumeAt=2026-10-19T06:00:00.000Z',
      'errorClass=rate_limit',
      'providerCount=2',
      'failureCount=3',
    ]);
    expect(audit.writes[1]).toEqual([
      'llm_recovery_attempt_admitted',
      'instance=owner-1',
      'invocation=inv-1',
      'revision=13',
      'attempt=att-1',
      'trigger=user_message',
      'interventions=1',
    ]);
    expect(audit.writes[2]).toEqual([
      'llm_recovery_attempt_finished',
      'instance=owner-1',
      'invocation=inv-1',
      'revision=14',
      'attempt=att-1',
      'outcome=completed',
      'accepted=true',
    ]);
    expect(audit.writes[3]).toEqual([
      'llm_recovery_ready',
      'instance=owner-1',
      'invocation=inv-1',
      'attempt=att-1',
      'revision=14',
      'reason=success',
    ]);
    expect(audit.writes[4]).toEqual([
      'llm_recovery_state_write_failed',
      'instance=owner-1',
      'invocation=inv-1',
      'attempt=att-1',
      'context=noteFailure',
      'reason=ENOSPC',
    ]);
    // stream 路径保持全量转发
    expect(stream.events).toHaveLength(5);
  });

  it('fans out committed durability degradation to audit and stream (phase 2029)', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);
    sink.emit({
      type: 'recovery_state_write_degraded',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-1',
      attemptId: 'att-1',
      context: 'noteAttemptStarted',
      durability: 'committed_durability_unknown',
      reason: 'EIO: fsync failed',
    });
    expect(audit.writes).toEqual([[
      'llm_recovery_state_write_degraded',
      'instance=owner-1',
      'invocation=inv-1',
      'attempt=att-1',
      'context=noteAttemptStarted',
      'durability=committed_durability_unknown',
      'reason=EIO: fsync failed',
    ]]);
    expect(stream.events).toHaveLength(1);
    expect(stream.events[0]).toMatchObject({
      type: 'recovery_state_write_degraded',
      durability: 'committed_durability_unknown',
      reason: 'EIO: fsync failed',
    });
  });

  it('fans out instance-state write failure and durability degradation (phase 2042)', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);
    sink.emit({ type: 'instance_state_write_failed', context: 'provider_success', reason: 'ENOSPC' });
    sink.emit({
      type: 'instance_state_write_degraded',
      context: 'provider_failure',
      durability: 'committed_platform_limited',
      reason: 'ENOTSUP',
    });

    expect(audit.writes).toEqual([
      ['llm_instance_state_write_failed', 'context=provider_success', 'reason=ENOSPC'],
      ['llm_instance_state_write_degraded', 'context=provider_failure', 'durability=committed_platform_limited', 'reason=ENOTSUP'],
    ]);
    expect(stream.events).toEqual([
      expect.objectContaining({ type: 'instance_state_write_failed', context: 'provider_success', reason: 'ENOSPC' }),
      expect.objectContaining({ type: 'instance_state_write_degraded', durability: 'committed_platform_limited' }),
    ]);
  });

  it('recovery_scheduled with empty resumeAt renders resumeAt=none (on_change schedule)', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'recovery_scheduled',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-5',
      attemptId: 'att-5',
      revision: 5,
      scheduleKind: 'on_change',
      resumeAt: '',
      errorClass: 'permanent',
      providerCount: 1,
      failureCount: 1,
    });

    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'scheduleKind=on_change',
      'resumeAt=none',
    ]));
  });

  it('fans out a ready recovery schedule without inventing a resume time', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'recovery_scheduled',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-ready',
      attemptId: 'att-ready',
      revision: 6,
      scheduleKind: 'ready',
      resumeAt: '',
      errorClass: 'transient',
      providerCount: 2,
      failureCount: 1,
    });

    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'scheduleKind=ready',
      'resumeAt=none',
      'invocation=inv-ready',
      'failureCount=1',
    ]));
    expect(stream.events).toEqual([expect.objectContaining({
      type: 'recovery_scheduled', scheduleKind: 'ready', resumeAt: '',
      invocationId: 'inv-ready', failureCount: 1,
    })]);
  });

  it('writes attemptId correlation columns for call-path events and preserves stream payloads', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'call_invocation_started',
      orchestratorInstance: 'owner-1',
      invocationId: 'inv-1',
      attemptId: 'att-1',
      kind: 'call',
      configRevision: 0,
      candidates: [{ name: 'p', providerId: 'fp' }],
    });
    sink.emit({
      type: 'call_attempt_result',
      invocationId: 'inv-1',
      attemptId: 'att-1',
      attemptIndex: 0,
      provider: 'p',
      providerId: 'fp',
      outcome: 'success',
    });
    sink.emit({
      type: 'call_selection',
      invocationId: 'inv-1',
      attemptId: 'att-1',
      outcome: 'selected',
      provider: 'p',
      providerId: 'fp',
      attemptIndex: 0,
    });
    sink.emit({
      type: 'call_selection',
      invocationId: 'inv-unscoped',
      outcome: 'exhausted',
    });

    expect(audit.writes.map(write => write[0])).toEqual([
      'llm_call_invocation_started',
      'llm_call_attempt_result',
      'llm_call_selection',
      'llm_call_selection',
    ]);
    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'instance=owner-1', 'invocation=inv-1', 'attempt=att-1',
    ]));
    expect(audit.writes.slice(0, 3).map(write => write.find(col => col === 'attempt=att-1'))).toEqual([
      'attempt=att-1', 'attempt=att-1', 'attempt=att-1',
    ]);
    expect(audit.writes[3]).toContain('attempt=none');
    expect(stream.events.slice(0, 3)).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptId: 'att-1' }),
    ]));
  });

  it('persists input measurement phases with request and call correlation', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'input_measurement',
      invocationId: 'inv-1',
      attemptId: 'att-1',
      provider: 'p',
      model: 'model-x',
      observation: {
        kind: 'prepared',
        requestId: 'req-1',
        provider: 'p',
        model: 'model-x',
        descriptor: {
          revision: 'rev-1', provider: 'p', model: 'model-x', api: 'openai',
          contextWindow: 1_000_000, profile: 'deepseek-v41-text-v1',
        },
        measurement: { kind: 'estimated', tokens: 12, method: 'deepseek-v41-text', reason: 'test' },
        inputHash: 'hash-1',
        inputSource: 'unlinked',
      },
    });
    sink.emit({
      type: 'input_measurement',
      invocationId: 'inv-1',
      attemptId: 'att-1',
      provider: 'p',
      model: 'model-x',
      observation: {
        kind: 'completed',
        requestId: 'req-1',
        provider: 'p',
        model: 'model-x',
        inputSource: 'unlinked',
        usage: {
          unCachedInputTokens: 12,
          outputTokens: 3,
          cacheWriteInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 15,
        },
        effectiveInputTokens: 12,
        normalizedUsageInputTokens: 12,
        measuredInputTokens: 12,
        deltaTokens: 0,
        reconciliation: 'matched',
        descriptorRevision: 'rev-1',
        inputHash: 'hash-1',
        measurement: { kind: 'estimated', tokens: 12, method: 'deepseek-v41-text', reason: 'test' },
      },
    });

    expect(audit.writes).toEqual([
      [
        'llm_input_measurement', 'request=req-1', 'phase=prepared',
        'invocation=inv-1', 'attempt=att-1', 'provider=p', 'model=model-x',
        'revision=rev-1', 'method=deepseek-v41-text', 'input_tokens=12', 'input_hash=hash-1', 'input_source=unlinked',
        'measurement_kind=estimated', 'measurement_reason=test',
        'artifact_id=none', 'artifact_status=none', 'artifact_schema=none', 'artifact_hash_alg=none',
        'artifact_hash=none', 'artifact_bytes=none', 'redaction_policy=none', 'artifact_reason=none',
      ],
      [
        'llm_input_measurement', 'request=req-1', 'phase=completed',
        'invocation=inv-1', 'attempt=att-1', 'provider=p', 'model=model-x',
        'reconciliation=matched', 'measured_input_tokens=12', 'usage_input_tokens=none', 'effective_input_tokens=12', 'delta_tokens=0',
        'normalized_usage_input_tokens=12', 'raw_usage={"unCachedInputTokens":12,"outputTokens":3,"cacheWriteInputTokens":0,"cacheReadInputTokens":0,"totalTokens":15}',
        'revision=rev-1', 'input_hash=hash-1', 'input_source=unlinked', 'measurement_kind=estimated', 'measurement_reason=test', 'reason=none',
        'artifact_id=none', 'artifact_status=none', 'artifact_schema=none', 'artifact_hash_alg=none',
        'artifact_hash=none', 'artifact_bytes=none', 'redaction_policy=none', 'artifact_reason=none',
      ],
    ]);
    expect(stream.events).toEqual([
      expect.objectContaining({ type: 'input_measurement', invocationId: 'inv-1', attemptId: 'att-1' }),
      expect.objectContaining({ type: 'input_measurement', invocationId: 'inv-1', attemptId: 'att-1' }),
    ]);
  });

  it('preserves historical counted completed facts in exact audit columns and stream events', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);
    const preparedEvent: LLMEvent = {
      type: 'input_measurement', schemaVersion: 1,
      invocationId: 'inv-historical', attemptId: 'att-counted-completed', provider: 'p', model: 'm',
      observation: {
        kind: 'prepared', requestId: 'counted-completed', provider: 'p', model: 'm',
        descriptor: {
          revision: 'historical-rev', provider: 'p', model: 'm',
          api: 'anthropic-messages', contextWindow: 1_000_000,
          profile: 'deepseek-v41-flash-1017-v1',
        },
        measurement: { kind: 'counted', tokens: 12, method: 'deepseek-v41-template' },
        inputHash: HISTORICAL_HASH, inputSource: 'unlinked',
      },
    };
    const completedEvent: LLMEvent = {
      type: 'input_measurement', schemaVersion: 1,
      invocationId: 'inv-historical', attemptId: 'att-counted-completed', provider: 'p', model: 'm',
      observation: {
        kind: 'completed', requestId: 'counted-completed', provider: 'p', model: 'm',
        descriptorRevision: 'historical-rev', inputHash: HISTORICAL_HASH, inputSource: 'unlinked',
        measurement: { kind: 'counted', tokens: 12, method: 'deepseek-v41-template' },
        measuredInputTokens: 12, usage: { unCachedInputTokens: 15, outputTokens: 1 },
        totalUsageInputTokens: 15, normalizedUsageInputTokens: 15,
        deltaTokens: 3, reconciliation: 'mismatch', reason: 'historical-note',
      },
    };
    const events: LLMEvent[] = [preparedEvent, completedEvent];
    const before = structuredClone(events);

    for (const event of events) sink.emit(event);

    expect(events).toStrictEqual(before);
    expectStreamFacts(stream.events, before);
    expect(audit.writes).toStrictEqual([
      [
        'llm_input_measurement', 'request=counted-completed', 'phase=prepared',
        'invocation=inv-historical', 'attempt=att-counted-completed', 'provider=p', 'model=m',
        'revision=historical-rev', 'method=deepseek-v41-template', 'input_tokens=12',
        `input_hash=${HISTORICAL_HASH}`, 'input_source=unlinked',
        'measurement_kind=counted', 'measurement_reason=none',
        ...NO_ARTIFACT_AUDIT_COLUMNS,
      ],
      [
        'llm_input_measurement', 'request=counted-completed', 'phase=completed',
        'invocation=inv-historical', 'attempt=att-counted-completed', 'provider=p', 'model=m',
        'reconciliation=mismatch', 'measured_input_tokens=12', 'usage_input_tokens=15',
        'effective_input_tokens=15', 'delta_tokens=3', 'normalized_usage_input_tokens=15',
        'raw_usage={"unCachedInputTokens":15,"outputTokens":1}',
        'revision=historical-rev', `input_hash=${HISTORICAL_HASH}`, 'input_source=unlinked',
        'measurement_kind=counted', 'measurement_reason=none', 'reason=historical-note',
        ...NO_ARTIFACT_AUDIT_COLUMNS,
      ],
    ]);
    const terminal = stream.events[1] as Record<string, unknown>;
    expect(terminal.observation).not.toHaveProperty('effectiveInputTokens');
    expect((terminal.observation as Record<string, unknown>).measurement).not.toHaveProperty('reason');
  });

  it('keeps historical counted zero values distinct from absent fields without schema versions', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);
    const events: LLMEvent[] = [
      {
        type: 'input_measurement',
        invocationId: 'inv-historical', attemptId: 'att-counted-zero', provider: 'p', model: 'm',
        observation: {
          kind: 'prepared', requestId: 'counted-zero', provider: 'p', model: 'm',
          descriptor: {
            revision: 'historical-rev', provider: 'p', model: 'm',
            api: 'anthropic-messages', contextWindow: 1_000_000,
            profile: 'deepseek-v41-flash-1017-v1',
          },
          measurement: { kind: 'counted', tokens: 0, method: 'deepseek-v41-template' },
          inputHash: HISTORICAL_HASH, inputSource: 'unlinked',
        },
      },
      {
        type: 'input_measurement',
        invocationId: 'inv-historical', attemptId: 'att-counted-zero', provider: 'p', model: 'm',
        observation: {
          kind: 'completed', requestId: 'counted-zero', provider: 'p', model: 'm',
          descriptorRevision: 'historical-rev', inputHash: HISTORICAL_HASH, inputSource: 'unlinked',
          measurement: { kind: 'counted', tokens: 0, method: 'deepseek-v41-template' },
          measuredInputTokens: 0, usage: { unCachedInputTokens: 0, outputTokens: 1 },
          totalUsageInputTokens: 0, normalizedUsageInputTokens: 0,
          deltaTokens: 0, reconciliation: 'matched',
        },
      },
    ];
    const before = structuredClone(events);

    for (const event of events) sink.emit(event);

    expect(events).toStrictEqual(before);
    expectStreamFacts(stream.events, before);
    expect(audit.writes).toStrictEqual([
      [
        'llm_input_measurement', 'request=counted-zero', 'phase=prepared',
        'invocation=inv-historical', 'attempt=att-counted-zero', 'provider=p', 'model=m',
        'revision=historical-rev', 'method=deepseek-v41-template', 'input_tokens=0',
        `input_hash=${HISTORICAL_HASH}`, 'input_source=unlinked',
        'measurement_kind=counted', 'measurement_reason=none',
        ...NO_ARTIFACT_AUDIT_COLUMNS,
      ],
      [
        'llm_input_measurement', 'request=counted-zero', 'phase=completed',
        'invocation=inv-historical', 'attempt=att-counted-zero', 'provider=p', 'model=m',
        'reconciliation=matched', 'measured_input_tokens=0', 'usage_input_tokens=0',
        'effective_input_tokens=0', 'delta_tokens=0', 'normalized_usage_input_tokens=0',
        'raw_usage={"unCachedInputTokens":0,"outputTokens":1}',
        'revision=historical-rev', `input_hash=${HISTORICAL_HASH}`, 'input_source=unlinked',
        'measurement_kind=counted', 'measurement_reason=none', 'reason=none',
        ...NO_ARTIFACT_AUDIT_COLUMNS,
      ],
    ]);
    const terminal = stream.events[1] as Record<string, unknown>;
    expect(terminal).not.toHaveProperty('schemaVersion');
    expect(terminal.observation).not.toHaveProperty('effectiveInputTokens');
    expect((terminal.observation as Record<string, unknown>).measurement).not.toHaveProperty('reason');
  });

  it('preserves historical counted failed facts without inventing completion fields', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);
    const events: LLMEvent[] = [
      {
        type: 'input_measurement',
        invocationId: 'inv-historical', attemptId: 'att-counted-failed', provider: 'p', model: 'm',
        observation: {
          kind: 'prepared', requestId: 'counted-failed', provider: 'p', model: 'm',
          descriptor: {
            revision: 'historical-rev', provider: 'p', model: 'm',
            api: 'anthropic-messages', contextWindow: 1_000_000,
            profile: 'deepseek-v41-flash-1017-v1',
          },
          measurement: { kind: 'counted', tokens: 12, method: 'deepseek-v41-template' },
          inputHash: HISTORICAL_HASH, inputSource: 'unlinked',
        },
      },
      {
        type: 'input_measurement',
        invocationId: 'inv-historical', attemptId: 'att-counted-failed', provider: 'p', model: 'm',
        observation: {
          kind: 'failed', requestId: 'counted-failed', provider: 'p', model: 'm',
          descriptorRevision: 'historical-rev', inputHash: HISTORICAL_HASH, inputSource: 'unlinked',
          measurement: { kind: 'counted', tokens: 12, method: 'deepseek-v41-template' },
          measuredInputTokens: 12, reason: 'historical-provider-error',
        },
      },
    ];
    const before = structuredClone(events);

    for (const event of events) sink.emit(event);

    expect(events).toStrictEqual(before);
    expectStreamFacts(stream.events, before);
    expect(audit.writes).toStrictEqual([
      [
        'llm_input_measurement', 'request=counted-failed', 'phase=prepared',
        'invocation=inv-historical', 'attempt=att-counted-failed', 'provider=p', 'model=m',
        'revision=historical-rev', 'method=deepseek-v41-template', 'input_tokens=12',
        `input_hash=${HISTORICAL_HASH}`, 'input_source=unlinked',
        'measurement_kind=counted', 'measurement_reason=none',
        ...NO_ARTIFACT_AUDIT_COLUMNS,
      ],
      [
        'llm_input_measurement', 'request=counted-failed', 'phase=failed',
        'invocation=inv-historical', 'attempt=att-counted-failed', 'provider=p', 'model=m',
        'reason=historical-provider-error', 'measured_input_tokens=12',
        'revision=historical-rev', `input_hash=${HISTORICAL_HASH}`, 'input_source=unlinked',
        'measurement_kind=counted', 'measurement_reason=none',
        ...NO_ARTIFACT_AUDIT_COLUMNS,
      ],
    ]);
    const terminal = stream.events[1] as Record<string, unknown>;
    expect(terminal).not.toHaveProperty('schemaVersion');
    expect(terminal.observation).not.toHaveProperty('usage');
    expect(terminal.observation).not.toHaveProperty('deltaTokens');
    expect(terminal.observation).not.toHaveProperty('reconciliation');
    expect((terminal.observation as Record<string, unknown>).measurement).toStrictEqual({
      kind: 'counted', tokens: 12, method: 'deepseek-v41-template',
    });
  });

  it('preserves modern estimated measurement facts as a control', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);
    const events: LLMEvent[] = [
      {
        type: 'input_measurement', schemaVersion: 1,
        invocationId: 'inv-historical', attemptId: 'att-modern-estimated', provider: 'p', model: 'm',
        observation: {
          kind: 'prepared', requestId: 'modern-estimated', provider: 'p', model: 'm',
          descriptor: {
            revision: 'historical-rev', provider: 'p', model: 'm',
            api: 'anthropic-messages', contextWindow: 1_000_000, profile: 'legacy-cl100k-v2',
          },
          measurement: { kind: 'estimated', tokens: 7, method: 'legacy-cl100k', reason: 'modern-estimate' },
          inputHash: HISTORICAL_HASH, inputSource: 'unlinked',
        },
      },
      {
        type: 'input_measurement', schemaVersion: 1,
        invocationId: 'inv-historical', attemptId: 'att-modern-estimated', provider: 'p', model: 'm',
        observation: {
          kind: 'completed', requestId: 'modern-estimated', provider: 'p', model: 'm',
          descriptorRevision: 'historical-rev', inputHash: HISTORICAL_HASH, inputSource: 'unlinked',
          measurement: { kind: 'estimated', tokens: 7, method: 'legacy-cl100k', reason: 'modern-estimate' },
          measuredInputTokens: 7, usage: { unCachedInputTokens: 7, outputTokens: 1 },
          totalUsageInputTokens: 7, normalizedUsageInputTokens: 7,
          deltaTokens: 0, reconciliation: 'matched',
        },
      },
    ];
    const before = structuredClone(events);

    for (const event of events) sink.emit(event);

    expect(events).toStrictEqual(before);
    expectStreamFacts(stream.events, before);
    expect(audit.writes).toStrictEqual([
      [
        'llm_input_measurement', 'request=modern-estimated', 'phase=prepared',
        'invocation=inv-historical', 'attempt=att-modern-estimated', 'provider=p', 'model=m',
        'revision=historical-rev', 'method=legacy-cl100k', 'input_tokens=7',
        `input_hash=${HISTORICAL_HASH}`, 'input_source=unlinked',
        'measurement_kind=estimated', 'measurement_reason=modern-estimate',
        ...NO_ARTIFACT_AUDIT_COLUMNS,
      ],
      [
        'llm_input_measurement', 'request=modern-estimated', 'phase=completed',
        'invocation=inv-historical', 'attempt=att-modern-estimated', 'provider=p', 'model=m',
        'reconciliation=matched', 'measured_input_tokens=7', 'usage_input_tokens=7',
        'effective_input_tokens=7', 'delta_tokens=0', 'normalized_usage_input_tokens=7',
        'raw_usage={"unCachedInputTokens":7,"outputTokens":1}',
        'revision=historical-rev', `input_hash=${HISTORICAL_HASH}`, 'input_source=unlinked',
        'measurement_kind=estimated', 'measurement_reason=modern-estimate', 'reason=none',
        ...NO_ARTIFACT_AUDIT_COLUMNS,
      ],
    ]);
  });

  it('persists the complete input artifact manifest without persisting input bytes', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'input_measurement',
      invocationId: 'inv-artifact',
      attemptId: 'att-artifact',
      provider: 'p',
      model: 'model-x',
      observation: {
        kind: 'failed',
        requestId: 'req-artifact',
        provider: 'p',
        model: 'model-x',
        inputSource: 'artifact',
        reason: 'provider_failed',
        artifactRef: {
          artifactId: 'input-artifact-req-artifact',
          schemaVersion: 1,
          status: 'available',
          hashAlgorithm: 'sha256',
          contentHash: 'b'.repeat(64),
          byteLength: 128,
        },
      },
    });

    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'artifact_id=input-artifact-req-artifact',
      'artifact_status=available',
      'artifact_schema=1',
      'artifact_hash_alg=sha256',
      `artifact_hash=${'b'.repeat(64)}`,
      'artifact_bytes=128',
      'redaction_policy=none',
      'artifact_reason=none',
    ]));
    expect(stream.events[0]).toMatchObject({
      observation: { artifactRef: { artifactId: 'input-artifact-req-artifact', status: 'available' } },
    });
  });

  it('fans out provider_close_failed to audit and stream with the original error', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({ type: 'provider_close_failed', error: 'Error: bad close' });

    expect(audit.writes).toEqual([[
      'llm_provider_close_failed',
      'error=Error: bad close',
    ]]);
    expect(stream.events).toHaveLength(1);
    expect(stream.events[0]).toMatchObject({
      type: 'provider_close_failed',
      error: 'Error: bad close',
    });
  });

  it('fans out legacy config diagnostics with the received values', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'legacy_config_ignored',
      field: 'circuitBreaker',
      reason: 'provider_retry_at_policy',
      value: { failureThreshold: 7, resetTimeoutMs: 120_000 }, // time-fixture: configuration/payload round-trip input, not an independent wait budget
    });

    expect(audit.writes).toEqual([[
      'llm_legacy_config_ignored',
      'field=circuitBreaker',
      'reason=provider_retry_at_policy',
      'failureThreshold=7',
      'resetTimeoutMs=120000',
    ]]);
    expect(stream.events).toEqual([expect.objectContaining({
      type: 'legacy_config_ignored', field: 'circuitBreaker',
      reason: 'provider_retry_at_policy',
      value: { failureThreshold: 7, resetTimeoutMs: 120_000 }, // time-fixture: configuration/payload round-trip input, not an independent wait budget
    })]);
  });

  it('persists complete hedge usage without turning missing values into zeroes', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);
    const usage = {
      inputTokens: 15,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 2,
      totalTokens: 20,
      details: { reasoningTokens: 1 },
    };

    sink.emit({
      type: 'hedge_fallback_committed',
      winnerProvider: 'fallback',
      primaryProvider: 'primary',
      primaryError: 'failed',
      primaryErrorClass: 'transient',
      usage,
    });
    sink.emit({ type: 'hedge_primary_recovered', provider: 'primary' });

    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'usage_schema=provider_usage_v1',
      'usage={"inputTokens":15,"outputTokens":5,"cacheReadInputTokens":0,"cacheWriteInputTokens":2,"totalTokens":20,"details":{"reasoningTokens":1}}',
    ]));
    expect(audit.writes[1]).toEqual(expect.arrayContaining([
      'usage_schema=provider_usage_v1',
      'usage=none',
    ]));
    expect(audit.writes.flat()).not.toContain('cache_read_input_tokens=0');
    expect(stream.events[0]).toMatchObject({ usage });
    expect(stream.events[1]).toMatchObject({ type: 'hedge_primary_recovered' });
  });

  it('reads historical measurement aliases and keeps no_usage distinct from zero', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    sink.emit({
      type: 'input_measurement',
      provider: 'p',
      model: 'm',
      observation: {
        kind: 'completed',
        requestId: 'historical',
        provider: 'p',
        model: 'm',
        inputSource: 'unlinked',
        usage: { unCachedInputTokens: 4, outputTokens: 1 },
        totalUsageInputTokens: 4,
        normalizedUsageInputTokens: 4,
        reconciliation: 'unavailable',
      },
    });
    sink.emit({
      type: 'input_measurement',
      provider: 'p',
      model: 'm',
      observation: {
        kind: 'completed',
        requestId: 'no-usage',
        provider: 'p',
        model: 'm',
        inputSource: 'unlinked',
        reconciliation: 'no_usage',
      },
    });

    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'effective_input_tokens=4',
      'usage_input_tokens=4',
      'normalized_usage_input_tokens=4',
    ]));
    expect(audit.writes[1]).toEqual(expect.arrayContaining([
      'effective_input_tokens=none',
      'usage_input_tokens=none',
      'normalized_usage_input_tokens=none',
      'raw_usage=none',
      'reconciliation=no_usage',
    ]));
  });

  it('normalizes Error payload to readable string in stream', () => {
    const audit = makeAudit();
    const stream = makeStream();
    const sink = createLLMEventSink(audit, stream);

    const error = new Error('underlying failure');
    sink.emit({
      type: 'hedge_primary_post_first_chunk_failure',
      provider: 'openai',
      error,
    });

    expect(stream.events).toHaveLength(1);
    const streamEvent = stream.events[0] as Record<string, unknown>;
    expect(streamEvent.type).toBe('hedge_primary_post_first_chunk_failure');
    expect(streamEvent.error).toContain('underlying failure');
    expect(streamEvent.error).not.toBeInstanceOf(Error);
  });
});
