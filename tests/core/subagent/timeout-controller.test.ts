import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTimeoutController } from '../../../src/core/subagent/timeout-controller.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
// phase 1858 Step K (SA-D10): controller 消费 lifecycle sink（真 adapter 保列格式）
import { createSubAgentLifecycleSink } from '../../../src/core/subagent/lifecycle-sink.js';

describe('subagent timeout controller audit semantics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normal cleanup does not emit timeout rejection', async () => {
    const write = vi.fn();
    const handle = createTimeoutController({
      timeoutMs: 1_000,
      sink: createSubAgentLifecycleSink({ auditWriter: { write } as any, agentId: 'agent-1' }),
    });

    handle.cleanup();
    await handle.timeoutPromise.catch(() => undefined);

    expect(write).not.toHaveBeenCalledWith(
      SUBAGENT_AUDIT_EVENTS.TIMEOUT_REJECTION,
      expect.anything(),
      expect.anything(),
    );
  });

  it('turn timeout emits exactly one timeout rejection', async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const handle = createTimeoutController({
      timeoutMs: 100,
      sink: createSubAgentLifecycleSink({ auditWriter: { write } as any, agentId: 'agent-2' }),
    });

    const settled = handle.timeoutPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    await settled;

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      SUBAGENT_AUDIT_EVENTS.TIMEOUT_REJECTION,
      'agentId=agent-2',
      expect.stringContaining('subagent_run'),
    );
    handle.cleanup();
  });

  it('onIdleTimeout throw → audit 留证一行 + idle abort 照常（phase 1858 Step L）', async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const sink = createSubAgentLifecycleSink({ auditWriter: { write } as any, agentId: 'agent-idle' });
    const handle = createTimeoutController({
      timeoutMs: 60_000,
      idleTimeoutMs: 50,
      onIdleTimeout: () => { throw new Error('idle callback boom'); },
      sink,
    });
    handle.resetIdle?.();
    const settled = handle.timeoutPromise.catch((e) => e);

    await vi.advanceTimersByTimeAsync(50);

    // ① 留证：一行 idle-timeout callback failure（audit 列含 agentId + error）
    const idleRows = write.mock.calls.filter(
      (c) => c[0] === SUBAGENT_AUDIT_EVENTS.IDLE_TIMEOUT_CALLBACK_FAILED,
    );
    expect(idleRows).toHaveLength(1);
    expect(idleRows[0]).toContain('agentId=agent-idle');
    expect(String(idleRows[0].join(' '))).toContain('idle callback boom');

    // ② abort 照常：idle_timeout 终止信号仍然发出
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as { reason?: { kind?: string } }).reason?.kind).toBe('idle_timeout');
    expect(handle.signal.aborted).toBe(true);
    handle.cleanup();
  });

  it('onIdleTimeout 正常 → 零 idle-timeout 故障行（phase 1858 Step L）', async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const onIdleTimeout = vi.fn();
    const sink = createSubAgentLifecycleSink({ auditWriter: { write } as any, agentId: 'agent-idle-ok' });
    const handle = createTimeoutController({
      timeoutMs: 60_000,
      idleTimeoutMs: 50,
      onIdleTimeout,
      sink,
    });
    handle.resetIdle?.();
    const settled = handle.timeoutPromise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(50);
    await settled;

    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    const idleRows = write.mock.calls.filter(
      (c) => c[0] === SUBAGENT_AUDIT_EVENTS.IDLE_TIMEOUT_CALLBACK_FAILED,
    );
    expect(idleRows).toHaveLength(0);
    handle.cleanup();
  });

  it('pre-aborted external signal rejects immediately with its reason', async () => {
    const external = new AbortController();
    external.abort({ type: 'external', original: 'already stopped' });
    const handle = createTimeoutController({
      timeoutMs: 1_000,
      externalSignal: external.signal,
      sink: createSubAgentLifecycleSink({ auditWriter: { write: vi.fn() } as any, agentId: 'agent-pre-abort' }),
    });

    await expect(handle.timeoutPromise).rejects.toMatchObject({
      name: 'AbortError',
      abortReason: { type: 'external', original: 'already stopped' },
    });
    expect(handle.signal.aborted).toBe(true);
    handle.cleanup();
  });
});
