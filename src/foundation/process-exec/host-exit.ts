/** Host notifications only; shutdown policy and persistence belong to the subscriber. */
export interface HostExitEvent {
  readonly cause: 'interrupt' | 'termination_request';
  /** Sequence is local to this subscription. */
  readonly sequence: number;
  readonly observedAt: number;
  readonly evidence: { readonly signal: 'SIGINT' | 'SIGTERM'; readonly platform: NodeJS.Platform };
}

export class HostExitSubscriptionError extends AggregateError {
  readonly code = 'HOST_EXIT_SUBSCRIPTION_FAILED';
  constructor(readonly stage: 'install' | 'unsubscribe', errors: unknown[]) {
    super(errors, `Host exit subscription ${stage} failed`, { cause: errors[0] });
    this.name = 'HostExitSubscriptionError';
  }
}

export function subscribeHostExit(
  listener: (event: HostExitEvent) => void | Promise<void>,
  onFailure: (error: unknown, event: HostExitEvent) => void | Promise<void>,
): () => void {
  let active = true;
  let sequence = 0;
  const installed = new Map<'SIGINT' | 'SIGTERM', () => void>();
  const unsubscribe = (): void => {
    active = false;
    const failures: unknown[] = [];
    for (const [signal, handler] of installed) {
      try {
        process.removeListener(signal, handler);
        installed.delete(signal);
      } catch (error) {
        // Preserve every removal failure for the typed error below; retain failed entries for retry.
        const removalError = error;
        failures.push(removalError);
      }
    }
    if (failures.length) throw new HostExitSubscriptionError('unsubscribe', failures);
  };
  const reportFailure = (error: unknown, event: HostExitEvent): void => {
    const exposeFailure = (reportError: unknown): void => {
      queueMicrotask(() => {
        throw new AggregateError([error, reportError], 'Host exit listener and failure handler failed', { cause: error });
      });
    };
    try {
      void Promise.resolve(onFailure(error, event)).catch(exposeFailure);
    } catch (reportError) { // silent: exposeFailure schedules the combined error.
      exposeFailure(reportError);
    }
  };
  try {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = (): void => {
        if (!active) return;
        const event: HostExitEvent = {
          cause: signal === 'SIGINT' ? 'interrupt' : 'termination_request',
          sequence: ++sequence, observedAt: Date.now(),
          evidence: { signal, platform: process.platform },
        };
        try {
          void Promise.resolve(listener(event)).catch(error => reportFailure(error, event));
        } catch (error) { // silent: reportFailure schedules the observed failure.
          reportFailure(error, event);
        }
      };
      process.on(signal, handler);
      installed.set(signal, handler);
    }
  } catch (error) {
    const failures = [error];
    try { unsubscribe(); } catch (cleanupError) { // silent: retain cleanup failure in typed install error.
      const removalError = cleanupError;
      failures.push(removalError);
    }
    throw new HostExitSubscriptionError('install', failures);
  }
  return unsubscribe;
}
