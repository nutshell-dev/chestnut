import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeHostExit, HostExitSubscriptionError } from '../../../src/foundation/process-exec/host-exit.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const unsubscribe of cleanup.splice(0)) unsubscribe();
});
function subscribe(listener: Parameters<typeof subscribeHostExit>[0], failure = vi.fn()) {
  const unsubscribe = subscribeHostExit(listener, failure);
  cleanup.push(unsubscribe);
  return unsubscribe;
}

describe('host exit subscription', () => {
  it('delivers neutral causes and per-subscription sequence without exiting', () => {
    const listener = vi.fn();
    subscribe(listener);
    process.emit('SIGINT');
    process.emit('SIGTERM');
    expect(listener.mock.calls.map(([event]) => [event.cause, event.sequence]))
      .toEqual([['interrupt', 1], ['termination_request', 2]]);
    expect(listener.mock.calls[0][0]).toMatchObject({ observedAt: expect.any(Number), evidence: { signal: 'SIGINT', platform: process.platform } });
  });
  it('unsubscribes only its own listeners and is idempotent', () => {
    const first = vi.fn();
    const second = vi.fn();
    const remove = subscribe(first);
    subscribe(second);
    remove(); remove();
    process.emit('SIGINT');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
  it.each([false, true])('reports listener failure without blocking others: async=%s', async (asynchronous) => {
    const error = new Error('listener failed');
    const failure = vi.fn();
    subscribe(() => { if (asynchronous) return Promise.reject(error); throw error; }, failure);
    const other = vi.fn();
    subscribe(other);
    process.emit('SIGTERM');
    await Promise.resolve();
    expect(failure).toHaveBeenCalledWith(error, expect.objectContaining({ cause: 'termination_request' }));
    expect(other).toHaveBeenCalledOnce();
  });
  it('preserves both failures when the failure outlet throws', () => {
    const original = new Error('original');
    const diagnostic = new Error('diagnostic');
    const callbacks: Array<() => void> = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => { callbacks.push(callback); });
    subscribe(() => { throw original; }, vi.fn(() => { throw diagnostic; }));
    process.emit('SIGINT');
    expect(callbacks).toHaveLength(1);
    let caught: unknown;
    try { callbacks[0](); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([original, diagnostic]);
  });
  it('rolls back a partially installed subscription', () => {
    const before = process.listenerCount('SIGINT');
    const original = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'SIGTERM') throw new Error('install failed');
      return original(event, handler);
    });
    expect(() => subscribeHostExit(vi.fn(), vi.fn())).toThrow(HostExitSubscriptionError);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
  it('retains a failed removal for a later unsubscribe retry without delivering more events', () => {
    const listener = vi.fn();
    const remove = subscribe(listener);
    const original = process.removeListener.bind(process);
    let reject = true;
    vi.spyOn(process, 'removeListener').mockImplementation((event, handler) => {
      if (event === 'SIGINT' && reject) throw new Error('remove failed');
      return original(event, handler);
    });
    expect(remove).toThrow(HostExitSubscriptionError);
    process.emit('SIGINT');
    expect(listener).not.toHaveBeenCalled();
    reject = false;
    expect(remove).not.toThrow();
  });

});
