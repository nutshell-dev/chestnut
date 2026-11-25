/**
 * @module L2c.Tools
 * In-memory execution reference. Timeout and stop observations are not settlement.
 */

import type {
  StopReceipt,
  ToolExecutionFinal,
  ToolExecutionRef,
  ToolExecutionView,
} from './types.js';

type StopHandler = (reason: unknown) => Promise<ToolExecutionFinal['persistence']['stops'][number]>;
type ObserverErrorHandler = (error: unknown) => void;

export class ToolExecution implements ToolExecutionRef {
  readonly completion: Promise<ToolExecutionFinal>;

  private resolveCompletion!: (final: ToolExecutionFinal) => void;
  private readonly listeners = new Set<(view: ToolExecutionView) => void>();
  private seq = 0;
  private view: ToolExecutionView;
  private final?: ToolExecutionFinal;
  private hasStopReason = false;

  constructor(
    readonly id: string,
    private readonly stopHandler: StopHandler,
    private readonly onObserverError: ObserverErrorHandler,
  ) {
    this.view = { id, seq: this.seq, state: 'running' };
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  get current(): ToolExecutionView {
    return this.view;
  }

  get firstStopReason(): unknown {
    return this.hasStopReason ? this.view.stopReason : undefined;
  }

  observe(listener: (view: ToolExecutionView) => void): () => void {
    // Register before reading the snapshot so an intervening transition cannot be lost.
    this.listeners.add(listener);
    this.notify(listener, this.view);
    return () => { this.listeners.delete(listener); };
  }

  async requestStop(reason: unknown): Promise<StopReceipt> {
    if (this.final) {
      return {
        executionId: this.id,
        accepted: false,
        state: 'settled',
        reason,
        persisted: false,
      };
    }

    if (!this.hasStopReason) {
      this.hasStopReason = true;
      this.publish({ stopReason: reason, state: 'stopping' });
    } else if (this.view.state !== 'stopping') {
      this.publish({ state: 'stopping' });
    }

    const persistence = await this.stopHandler(reason);
    return {
      executionId: this.id,
      accepted: true,
      state: this.view.state,
      reason,
      persisted: persistence.persisted,
      persistence,
    };
  }

  markTimeout(result: ToolExecutionFinal['presentedResult'], reason: unknown): void {
    if (this.final) return;
    if (this.hasStopReason) {
      this.publish({ state: 'stopping', presentedResult: result });
      return;
    }
    this.publish({ state: 'stopping', presentedResult: result, stopReason: reason });
    this.hasStopReason = true;
  }

  markCleanupPending(): void {
    if (this.final) return;
    this.publish({ state: 'stopping', cleanup: 'pending' });
  }

  settle(final: ToolExecutionFinal): void {
    if (this.final) return;
    this.final = final;
    this.publish({
      state: 'settled',
      cleanup: this.view.cleanup ?? 'settled',
      presentedResult: final.presentedResult,
      final,
    });
    this.resolveCompletion(final);
  }

  private publish(update: Partial<ToolExecutionView>): void {
    this.view = { ...this.view, ...update, seq: ++this.seq };
    for (const listener of [...this.listeners]) this.notify(listener, this.view);
  }

  private notify(listener: (view: ToolExecutionView) => void, view: ToolExecutionView): void {
    try {
      listener(view);
    } catch (error) {
      // One observer cannot prevent settlement or other observers from progressing.
      this.onObserverError(error);
    }
  }
}

export function createSettledToolExecution(
  id: string,
  final: ToolExecutionFinal,
  onObserverError: ObserverErrorHandler,
): ToolExecution {
  const execution = new ToolExecution(
    id,
    async () => ({
      path: final.persistence.journalPath,
      kind: 'unavailable',
      persisted: false,
      durable: false,
      error: 'execution already settled',
    }),
    onObserverError,
  );
  execution.settle(final);
  return execution;
}
