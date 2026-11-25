/**
 * @module L3.SubAgent.ExecutionRunner
 * Phase 2248 Step D: claim-backed, self-owned SubAgent execution.
 *
 * The runner retains the actual attempt promise. Stop only records/signals;
 * outcome commit, writer close and completion are deliberately separate steps.
 */

import * as path from 'node:path';
import { formatErr } from '../../foundation/node-utils/index.js';
import { ToolTimeoutError } from '../../foundation/tools/index.js';
import { llmProviderAbort } from '../../foundation/llm-provider/index.js';
import { isStepAbortError } from '../step-executor/index.js';
import { RecoveryUncertainSideEffectError } from './recovery-state.js';
import {
  SubagentRunnerImpl,
  SubagentExecutionReference,
  type SubagentRunnerExecutionHooks,
} from './execution-reference.js';
import type {
  SubagentArtifactReference,
  SubagentExecutionDegraded,
  SubagentExecutionOptions,
  SubagentExecutionRef,
  SubagentFinalOutcome,
  SubagentJsonValue,
  SubagentObservation,
  SubagentOutcomeKind,
  SubagentRecoveryFact,
  SubagentResumeRequest,
  SubagentRunner,
  SubagentSettlementInput,
  SubagentStartRequest,
  SubagentExecutionQuery,
} from './execution-types.js';

const { ExternalAbortError, isAbortError } = llmProviderAbort;

export interface SubagentAttemptResult {
  readonly content: string;
  readonly rawResult?: SubagentJsonValue;
  readonly artifacts?: readonly SubagentArtifactReference[];
}

export interface SubagentAttempt {
  /** The real runReact/tool/persistence promise, already owned by this attempt. */
  readonly completion: Promise<SubagentAttemptResult>;
  /** Close this attempt's writer. Called after outcome commit, before completion. */
  close(): void;
  /** A real late result observed while the original stop cause remains authoritative. */
  lateResult?(): SubagentAttemptResult | undefined;
  /** Includes failures; called only after the real execution has converged. */
  degraded?(): readonly SubagentExecutionDegraded[];
}

export interface SubagentExecutionDriver {
  createAttempt(request: {
    readonly input: SubagentJsonValue;
    readonly signal: AbortSignal;
    readonly deadlineAtMs?: number;
    readonly resume: boolean;
  }): SubagentAttempt;
  /** Shared LLM dependency classification stays behind the fixed runtime capability. */
  recoveryFor?(error: unknown): SubagentRecoveryFact;
}

export interface SubagentExecutionRunnerOptions extends SubagentExecutionOptions {
  readonly driver: SubagentExecutionDriver;
}

function isInterruption(error: unknown): boolean {
  return error instanceof ToolTimeoutError || isStepAbortError(error) || isAbortError(error);
}

export class SubagentExecutionRunner implements SubagentRunner {
  private readonly runner: SubagentRunnerImpl;

  constructor(private readonly options: SubagentExecutionRunnerOptions) {
    const hooks: SubagentRunnerExecutionHooks = {
      start: (ref, request) => { this.own(ref, request); },
    };
    this.runner = new SubagentRunnerImpl(options, hooks);
  }

  start(request: SubagentStartRequest): Promise<SubagentExecutionRef> {
    return this.runner.start(request);
  }

  open(identity: SubagentExecutionQuery): Promise<SubagentObservation> {
    return this.runner.open(identity);
  }

  resume(request: SubagentResumeRequest): Promise<SubagentExecutionRef> {
    return this.runner.resume(request);
  }

  private own(
    ref: SubagentExecutionReference,
    request: {
      readonly input: SubagentJsonValue;
      readonly signal?: AbortSignal;
      readonly deadlineAtMs?: number;
      readonly resume: boolean;
    },
  ): void {
    const controller = new AbortController();
    const disposers = new Set<() => void>();
    let attempt: SubagentAttempt | undefined;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      try {
        attempt?.close();
      } finally {
        for (const dispose of disposers) dispose();
        disposers.clear();
      }
    };
    ref.bindRuntime({
      stop: reason => { if (!closed) controller.abort(reason); },
      addSignal: signal => {
        if (closed) return;
        if (signal.aborted) {
          controller.abort(signal.reason);
          return;
        }
        const onAbort = () => { controller.abort(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
        const dispose = () => { signal.removeEventListener('abort', onAbort); };
        disposers.add(dispose);
      },
      close,
    });
    ref.attachSignal(request.signal);

    // Intentionally not awaited by start: claim/input/prepared are committed, while
    // this owner keeps running until the actual attempt and final settlement finish.
    void this.drive(ref, controller, request, () => attempt, value => { attempt = value; })
      .catch(error => { // silent: routed to structured observer evidence or stderr; never presented as success
        this.settlementError(error, ref);
      });
  }

  private settlementError(error: unknown, ref: SubagentExecutionReference): void {
    // Settlement/close failures cannot be rewritten into a fictitious outcome.
    if (this.options.onObserverError) this.options.onObserverError(error, ref.identity);
    else process.stderr.write(`[subagent] execution settlement failed for ${ref.identity.runId}/${ref.identity.attemptId}: ${formatErr(error)}\n`);
  }

  private async drive(
    ref: SubagentExecutionReference,
    controller: AbortController,
    request: {
      readonly input: SubagentJsonValue;
      readonly deadlineAtMs?: number;
      readonly resume: boolean;
    },
    getAttempt: () => SubagentAttempt | undefined,
    setAttempt: (attempt: SubagentAttempt) => void,
  ): Promise<SubagentFinalOutcome> {
    let result: SubagentAttemptResult | undefined;
    let failure: unknown;
    let failed = false;
    try {
      const running = await ref.transition({ state: 'running', reason: { kind: request.resume ? 'resume' : 'start' } });
      if (!running.event.persisted) {
        throw new Error(`running event commit failed: ${running.event.error ?? 'unknown'}`);
      }
      const attempt = this.options.driver.createAttempt({
        input: request.input,
        signal: controller.signal,
        ...(request.deadlineAtMs !== undefined ? { deadlineAtMs: request.deadlineAtMs } : {}),
        resume: request.resume,
      });
      setAttempt(attempt);
      result = await attempt.completion;
    } catch (error) {
      // silent: retained verbatim and normalized into the typed final outcome below.
      failed = true;
      failure = error;
    }

    const stopped = controller.signal.aborted;
    const interrupted = stopped || (failed && isInterruption(failure));
    let cause = failure;
    let lateFailure: SubagentJsonValue | undefined;
    if (stopped && (!failed || !isInterruption(failure))) {
      cause = new ExternalAbortError(controller.signal.reason);
      if (failed) lateFailure = { error: formatErr(failure) };
    }

    const kind: SubagentOutcomeKind = interrupted ? 'interrupted' : failed ? 'failed' : 'completed';
    let recovery: SubagentRecoveryFact = 'none';
    if (failed && !interrupted) {
      recovery = failure instanceof RecoveryUncertainSideEffectError
        ? 'uncertain_side_effect'
        : this.options.driver.recoveryFor?.(failure) ?? 'none';
    }
    const attempt = getAttempt();
    const late = result === undefined && interrupted ? attempt?.lateResult?.() : undefined;
    const presented = result ?? late;
    const outcome: SubagentSettlementInput = {
      kind,
      content: presented?.content ?? formatErr(cause),
      evidenceRef: path.join(
        ref.identity.resultDir,
        'execution',
        'attempts',
        String(ref.view.ordinal),
        'outcome.json',
      ),
      ...(presented?.rawResult !== undefined
        ? { rawResult: presented.rawResult }
        : lateFailure !== undefined ? { rawResult: lateFailure } : {}),
      ...(kind !== 'completed' ? { cause } : {}),
      recovery,
      artifacts: presented?.artifacts ?? [],
      degraded: attempt?.degraded?.() ?? [],
    };
    return ref.settle(outcome);
  }
}

export function createSubagentExecutionRunner(options: SubagentExecutionRunnerOptions): SubagentExecutionRunner {
  return new SubagentExecutionRunner(options);
}
