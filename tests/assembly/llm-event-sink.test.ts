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

    expect(stream.events).toHaveLength(1);
    expect(stream.events[0]).toMatchObject({ type: 'provider_attempt_failed' });
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
      scope: 'foreground',
      revision: 7,
      interventionIds: ['m1', 'm2'],
      configurationRevision: 'r-fixed',
      startupId: 'boot-1',
      attemptId: 'att-9',
    };
    sink.emit(event);

    expect(audit.writes).toHaveLength(1);
    expect(audit.writes[0][0]).toBe('llm_recovery_facts_accepted');
    expect(audit.writes[0]).toEqual(expect.arrayContaining([
      'scope=foreground',
      'revision=7',
      'interventions=m1,m2',
      'config=r-fixed',
      'startup=boot-1',
      'attempt=att-9',
    ]));

    expect(stream.events).toHaveLength(1);
    const streamEvent = stream.events[0] as Record<string, unknown>;
    expect(streamEvent.type).toBe('recovery_facts_accepted');
    expect(streamEvent.interventionIds).toEqual(['m1', 'm2']);
    expect(streamEvent.configurationRevision).toBe('r-fixed');
    expect(streamEvent.startupId).toBe('boot-1');
    expect(streamEvent.attemptId).toBe('att-9');
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
