/**
 * Event-driven Promise helper for test fixtures.
 *
 * Replaces polling-based waitFor for event-count and predicate-based assertions.
 *
 * Why event-driven over polling:
 * - 0 magic number (no timeout / interval / setTimeout 20ms)
 * - 0 race window (events between polls not missed)
 * - 0 假阳性 timeout（vitest test-level timeout 自然兜 hang case、错误位置清晰）
 *
 * Usage:
 *   const ec = createEventCollector<MyEvent>();
 *   subscribe(source, ec.onEvent);
 *   triggerSomething();
 *   await ec.whenCount(2);
 *   expect(ec.events).toMatchObject([...]);
 */

export interface EventCollector<T> {
  /** Read-only view of collected events. */
  readonly events: readonly T[];

  /** Push event into collector. Hook into source via callback/listener. */
  onEvent(e: T): void;

  /** Resolves when events.length >= n. Immediate if already met. */
  whenCount(n: number): Promise<void>;

  /** Resolves when predicate returns true on events array. Immediate if already met. */
  whenPredicate(p: (events: readonly T[]) => boolean): Promise<void>;

  /** Clear events + silently resolve all pending waiters (cleanup, not error). */
  reset(): void;
}

interface Waiter<T> {
  check: (events: readonly T[]) => boolean;
  resolve: () => void;
}

export function createEventCollector<T>(): EventCollector<T> {
  const events: T[] = [];
  const waiters: Array<Waiter<T>> = [];

  function tryFireWaiters(): void {
    // Iterate backwards to splice safely
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].check(events)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  }

  return {
    events,
    onEvent(e: T): void {
      events.push(e);
      tryFireWaiters();
    },
    whenCount(n: number): Promise<void> {
      const check = (es: readonly T[]) => es.length >= n;
      if (check(events)) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ check, resolve }));
    },
    whenPredicate(p: (events: readonly T[]) => boolean): Promise<void> {
      if (p(events)) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ check: p, resolve }));
    },
    reset(): void {
      events.length = 0;
      // Silently resolve pending waiters (no error / reset = cleanup)
      while (waiters.length > 0) {
        waiters.pop()!.resolve();
      }
    },
  };
}
