import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTimeoutController } from '../../../src/core/subagent/timeout-controller.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';

describe('subagent timeout controller audit semantics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normal cleanup does not emit timeout rejection', async () => {
    const write = vi.fn();
    const handle = createTimeoutController({
      timeoutMs: 1_000,
      auditWriter: { write } as any,
      agentId: 'agent-1',
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
      auditWriter: { write } as any,
      agentId: 'agent-2',
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
});
