import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { IdleTimeoutSignal } from '../../../src/core/step-executor/index.js';
import { dispatchError } from '../../../src/core/event-loop/error-handlers.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import {
  INTERRUPT_RECOVERY_DELAY_MS,
  UNKNOWN_ERROR_RECOVERY_DELAY_MS,
} from '../../../src/core/event-loop/constants.js';

function makeAudit(): AuditLog & { entries: unknown[][] } {
  const entries: unknown[][] = [];
  return {
    entries,
    write: (...cols: unknown[]) => { entries.push(cols); },
  } as AuditLog & { entries: unknown[][] };
}

describe('EventLoop error recovery delays', () => {
  afterEach(() => vi.useRealTimers());

  it('bounds an unknown-error retry and records the delay decision', async () => {
    vi.useFakeTimers();
    const audit = makeAudit();
    let settled = false;
    const dispatched = dispatchError(new Error('deterministic failure'), { audit })
      .then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(UNKNOWN_ERROR_RECOVERY_DELAY_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await dispatched;

    expect(audit.entries).toContainEqual([
      EVENTLOOP_AUDIT_EVENTS.FATAL,
      'reason=non_llm_error',
      `recovery_delay_ms=${UNKNOWN_ERROR_RECOVERY_DELAY_MS}`,
      'error=deterministic failure',
    ]);
  });

  it('abort interrupts the idle recovery delay', async () => {
    vi.useFakeTimers();
    const audit = makeAudit();
    const controller = new AbortController();
    const dispatched = dispatchError(new IdleTimeoutSignal(), {
      audit,
      signal: controller.signal,
    });

    controller.abort();
    await dispatched;
    expect(vi.getTimerCount()).toBe(0);
    expect(INTERRUPT_RECOVERY_DELAY_MS).toBeGreaterThan(0);
  });
});
