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
