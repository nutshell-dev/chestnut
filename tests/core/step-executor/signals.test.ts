/**
 * Runtime signal classes — basic invariants
 *
 * These tests verify properties that broke or could break across the phase101
 * refactor: signal classes are NOT Errors, instanceof narrowing works, and
 * throw/catch semantics are intact despite not extending Error.
 */

import { describe, it, expect } from 'vitest';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../../src/core/step-executor/signals.js';

describe('IdleTimeoutSignal', () => {
  it('is NOT an instance of Error', () => {
    const sig = new IdleTimeoutSignal(30000);
    expect(sig instanceof Error).toBe(false);
  });

  it('stores timeoutMs', () => {
    expect(new IdleTimeoutSignal(5000).timeoutMs).toBe(5000);
    expect(new IdleTimeoutSignal(0).timeoutMs).toBe(0);
  });

  it('has name = "IdleTimeoutSignal"', () => {
    expect(new IdleTimeoutSignal(1000).name).toBe('IdleTimeoutSignal');
  });

  it('instanceof narrows correctly after throw/catch', () => {
    let caught: unknown;
    try { throw new IdleTimeoutSignal(10000); } catch (e) { caught = e; }
    expect(caught instanceof IdleTimeoutSignal).toBe(true);
    if (caught instanceof IdleTimeoutSignal) {
      expect(caught.timeoutMs).toBe(10000);
    }
  });

  it('instanceof does NOT match Error', () => {
    let caught: unknown;
    try { throw new IdleTimeoutSignal(1000); } catch (e) { caught = e; }
    expect(caught instanceof Error).toBe(false);
  });
});

describe('PriorityInboxInterrupt', () => {
  it('is NOT an instance of Error', () => {
    expect(new PriorityInboxInterrupt() instanceof Error).toBe(false);
  });

  it('has name = "PriorityInboxInterrupt"', () => {
    expect(new PriorityInboxInterrupt().name).toBe('PriorityInboxInterrupt');
  });

  it('instanceof narrows correctly after throw/catch', () => {
    let caught: unknown;
    try { throw new PriorityInboxInterrupt(); } catch (e) { caught = e; }
    expect(caught instanceof PriorityInboxInterrupt).toBe(true);
  });
});

describe('UserInterrupt', () => {
  it('is NOT an instance of Error', () => {
    expect(new UserInterrupt() instanceof Error).toBe(false);
  });

  it('has name = "UserInterrupt"', () => {
    expect(new UserInterrupt().name).toBe('UserInterrupt');
  });

  it('instanceof narrows correctly after throw/catch', () => {
    let caught: unknown;
    try { throw new UserInterrupt(); } catch (e) { caught = e; }
    expect(caught instanceof UserInterrupt).toBe(true);
  });
});

describe('signal instanceof exclusivity', () => {
  it('each signal class only matches its own instanceof', () => {
    const timeout = new IdleTimeoutSignal(1000);
    const inbox = new PriorityInboxInterrupt();
    const user = new UserInterrupt();

    expect(timeout instanceof PriorityInboxInterrupt).toBe(false);
    expect(timeout instanceof UserInterrupt).toBe(false);
    expect(inbox instanceof IdleTimeoutSignal).toBe(false);
    expect(inbox instanceof UserInterrupt).toBe(false);
    expect(user instanceof IdleTimeoutSignal).toBe(false);
    expect(user instanceof PriorityInboxInterrupt).toBe(false);
  });
});
