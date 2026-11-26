import { vi } from 'vitest';
import type {
  SubagentExecutionDegraded,
  SubagentExecutionIdentity,
  SubagentExecutionRef,
  SubagentFinalOutcome,
  SubagentJsonValue,
  SubagentStartRequest,
} from '../../../src/core/subagent/index.js';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function executionIdentity(request: SubagentStartRequest): SubagentExecutionIdentity {
  return { runId: request.runId, attemptId: 'shadow-attempt-test', resultDir: request.resultDir };
}

export function executionRef(
  identity: SubagentExecutionIdentity,
  completion: Promise<SubagentFinalOutcome>,
): SubagentExecutionRef {
  return { identity, completion, read: vi.fn(), observe: vi.fn(), requestStop: vi.fn() };
}

export function completedOutcome(
  identity: SubagentExecutionIdentity,
  text: string,
  capturedResult?: SubagentJsonValue,
  degraded: readonly SubagentExecutionDegraded[] = [],
): SubagentFinalOutcome {
  return {
    identity,
    kind: 'completed',
    content: text,
    rawResult: {
      text,
      ...(capturedResult !== undefined ? { capturedResult } : {}),
    },
    recovery: 'none',
    artifacts: [],
    degraded,
    persistence: persistence(identity),
  };
}

export function terminalFailure(
  identity: SubagentExecutionIdentity,
  kind: 'interrupted' | 'failed',
  cause: unknown,
  degraded: readonly SubagentExecutionDegraded[] = [],
): SubagentFinalOutcome {
  return {
    identity,
    kind,
    content: cause instanceof Error ? cause.message : String(cause),
    cause,
    recovery: 'none',
    artifacts: [],
    degraded,
    persistence: persistence(identity),
  };
}

function persistence(identity: SubagentExecutionIdentity): SubagentFinalOutcome['persistence'] {
  const outcomePath = `${identity.resultDir}/execution/attempts/1/outcome.json`;
  return {
    executionDir: `${identity.resultDir}/execution`,
    outcome: { path: outcomePath, kind: 'durable', persisted: true, durable: true },
    events: [],
    stops: [],
  };
}
