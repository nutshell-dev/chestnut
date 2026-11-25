/**
 * Phase 2248 F: consume owner execution references without interpreting SubAgent
 * private cursors or importing upper-layer business owners.
 */

import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { TASKS_QUEUES_RESULTS_DIR } from './dirs.js';
import type { OwnedExecutionInputStore } from './execution-input-store.js';
import { clearLLMWait, loadLLMWait } from './llm-wait-state.js';
import type {
  FullTaskId,
  SubAgentTask,
  TaskExecutionIdentity,
  TaskExecutionLink,
  TaskExecutionObservation,
  TaskExecutionObserver,
  TaskExecutionPort,
  TaskExecutionRef,
  TaskExecutionState,
  TaskExecutionOutcome,
  TaskSharedRecovery,
  TaskSourceOutcome,
  TaskStopReceipt,
} from './types.js';

export const EXECUTION_LINK_FILE = 'execution-link.json' as const;

export class TaskExecutionConsumptionError extends Error {
  constructor(
    readonly code: 'link_corrupt' | 'observation_unavailable' | 'resume_identity_missing' | 'shared_recovery_unavailable',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TaskExecutionConsumptionError';
  }
}

export interface ConsumeTaskExecutionDeps {
  readonly fs: FileSystem;
  readonly execution: TaskExecutionPort;
  readonly inputStore: OwnedExecutionInputStore;
  readonly sharedRecovery?: TaskSharedRecovery;
  readonly onReference?: (ref: TaskExecutionRef) => void;
}

function linkPath(taskId: FullTaskId): string {
  return `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${EXECUTION_LINK_FILE}`;
}

function resultDir(task: SubAgentTask): string {
  return `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
}

async function readLink(fs: FileSystem, task: SubAgentTask): Promise<TaskExecutionLink | undefined> {
  let raw: string;
  try {
    raw = await fs.read(linkPath(task.id as FullTaskId));
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.schema_version !== 1 || parsed.runId !== task.id || parsed.resultDir !== resultDir(task)
      || typeof parsed.attemptId !== 'string' || parsed.attemptId.length === 0) {
      throw new Error('identity_or_schema_mismatch');
    }
    return {
      schema_version: 1,
      runId: task.id,
      resultDir: resultDir(task),
      attemptId: parsed.attemptId,
    };
  } catch (error) {
    throw new TaskExecutionConsumptionError('link_corrupt', `execution link for ${task.id} is corrupt`, { cause: error });
  }
}

export async function persistTaskExecutionLink(fs: FileSystem, task: SubAgentTask, identity: TaskExecutionIdentity): Promise<void> {
  if (identity.runId !== task.id || identity.resultDir !== resultDir(task)) {
    throw new TaskExecutionConsumptionError('observation_unavailable', `execution owner returned a different identity for ${task.id}`);
  }
  const link: TaskExecutionLink = { schema_version: 1, ...identity };
  await fs.writeAtomic(linkPath(task.id as FullTaskId), JSON.stringify(link, null, 2));
}

function stoppedReceipt(state: TaskExecutionState): TaskStopReceipt {
  return { accepted: false, state, persisted: false, durable: false };
}

/** Open is read-only at the owner boundary; ATS derives completion from observations. */
function referenceFromObserver(observer: TaskExecutionObserver, initial: TaskExecutionObservation & { readonly kind: 'found' }): TaskExecutionRef {
  let unsubscribe: (() => void) | undefined;
  let settled = false;
  const completion = new Promise<TaskSourceOutcome>(resolve => {
    const publish = (view: import('./types.js').TaskExecutionView): void => {
      if (settled || view.outcome === undefined) return;
      settled = true;
      resolve(view.outcome);
      unsubscribe?.();
    };
    publish(initial.view);
    if (!settled) {
      unsubscribe = observer.observe(publish);
      void observer.read().then(publish).catch(() => { // silent: later observer events/restart retain the failure boundary
      });
    }
  });
  if (settled) unsubscribe?.();
  return {
    identity: observer.identity,
    completion,
    read: () => observer.read(),
    observe: listener => observer.observe(listener),
    // A read-only open reference must not gain control authority. The false receipt
    // keeps cancellation pending instead of pretending the owner accepted a stop.
    requestStop: reason => observer.read().then(view => stoppedReceipt(view.state), error => {
      throw new TaskExecutionConsumptionError('observation_unavailable', `cannot stop read-only execution ${observer.identity.attemptId}: ${formatErr(reason)}`, { cause: error });
    }),
  };
}

async function openReference(
  execution: TaskExecutionPort,
  task: SubAgentTask,
): Promise<TaskExecutionRef> {
  const observation = await execution.open({ runId: task.id, resultDir: resultDir(task) });
  if (observation.kind !== 'found') {
    throw new TaskExecutionConsumptionError(
      'observation_unavailable',
      `cannot attach execution for ${task.id}: ${observation.kind}${'reason' in observation ? ` (${observation.reason})` : ''}`,
    );
  }
  return referenceFromObserver(observation.ref, observation);
}

function originalDeadline(task: SubAgentTask): number | undefined {
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) ? created + task.timeoutMs : undefined;
}

async function acquireReference(
  task: SubAgentTask,
  signal: AbortSignal,
  deps: ConsumeTaskExecutionDeps,
): Promise<TaskExecutionRef> {
  const { fs, execution, inputStore } = deps;
  const input = await inputStore.readPreparedInput(task.id as FullTaskId);
  const link = await readLink(fs, task);
  const wait = await loadLLMWait(fs, resultDir(task));
  if (wait?.kind === 'corrupt') {
    throw new TaskExecutionConsumptionError('link_corrupt', `cannot resume ${task.id} with corrupt LLM wait state: ${wait.detail}`);
  }
  const resumeIntent = wait?.kind === 'ok' ? wait.fact.resumeIntent : undefined;
  const waitIdentity = wait?.kind === 'ok' ? wait.fact.execution : undefined;
  const request = {
    runId: task.id,
    resultDir: resultDir(task),
    input,
    signal,
    ...(originalDeadline(task) !== undefined ? { deadlineAtMs: originalDeadline(task) } : {}),
  };

  if (link && resumeIntent) {
    if (!waitIdentity || waitIdentity.attemptId !== link.attemptId
      || waitIdentity.runId !== link.runId || waitIdentity.resultDir !== link.resultDir) {
      throw new TaskExecutionConsumptionError('resume_identity_missing', `waiting task ${task.id} has no matching previous execution identity`);
    }
    // resume is explicit and idempotent by previousAttemptId. Clearing the intent
    // before replacing the link makes a crash recover by open(latest), never start.
    const ref = await execution.resume({ ...request, previousAttemptId: link.attemptId });
    deps.onReference?.(ref);
    await clearLLMWait(fs, resultDir(task));
    await persistTaskExecutionLink(fs, task, ref.identity);
    return ref;
  }
  if (resumeIntent) {
    throw new TaskExecutionConsumptionError('resume_identity_missing', `waiting task ${task.id} has no execution link to resume`);
  }
  if (link) {
    const ref = await openReference(execution, task);
    deps.onReference?.(ref);
    // The linked attempt and a start/link-crash successor are both found by the
    // deterministic runId/resultDir query; persist the actual observed identity.
    await persistTaskExecutionLink(fs, task, ref.identity);
    return ref;
  }

  try {
    const ref = await execution.start(request);
    deps.onReference?.(ref);
    await persistTaskExecutionLink(fs, task, ref.identity);
    return ref;
  } catch (startOrLinkError) {
    // start() may have acquired a real attempt before this process failed to return
    // or persist its link. Re-open the deterministic location instead of starting
    // a second loop or reporting a fictitious task failure.
    let observation: TaskExecutionObservation;
    try {
      observation = await execution.open(request);
    } catch (openError) {
      throw new AggregateError([startOrLinkError, openError], `start/link recovery failed for ${task.id}`);
    }
    if (observation.kind !== 'found') throw startOrLinkError;
    const ref = referenceFromObserver(observation.ref, observation);
    deps.onReference?.(ref);
    try {
      await persistTaskExecutionLink(fs, task, ref.identity);
    } catch (linkError) {
      throw new AggregateError([startOrLinkError, linkError], `start/link recovery could not persist ${task.id}`);
    }
    return ref;
  }
}

function errorCategory(outcome: TaskSourceOutcome): string {
  if (typeof outcome.cause === 'object' && outcome.cause !== null
    && 'name' in outcome.cause && typeof outcome.cause.name === 'string') {
    return outcome.cause.name;
  }
  return outcome.kind === 'interrupted' ? 'TaskExecutionInterrupted' : 'TaskExecutionFailed';
}

/** Start/open/resume and await the actual owner completion before task handling. */
export async function consumeTaskExecution(
  task: SubAgentTask,
  signal: AbortSignal,
  deps: ConsumeTaskExecutionDeps,
): Promise<TaskExecutionOutcome> {
  const ref = await acquireReference(task, signal, deps);
  const outcome = await ref.completion;
  const base = {
    content: outcome.content,
    sourceIsError: outcome.kind !== 'completed',
    ...(outcome.kind !== 'completed' ? { errorCategory: errorCategory(outcome) } : {}),
  };
  if (outcome.kind !== 'failed') return base;

  if (outcome.recovery === 'uncertain_side_effect') {
    return { ...base, uncertain: { reason: outcome.content } };
  }
  if (outcome.recovery !== 'shared_dependency') return base;
  if (!deps.sharedRecovery) {
    throw new TaskExecutionConsumptionError(
      'shared_recovery_unavailable',
      `shared recovery decision is required for task ${task.id}`,
      { cause: outcome.cause },
    );
  }

  // Only ATS calls the injected owner decision. Timeout/cancel/interrupted outcomes
  // returned above can never enter LLM waiting, and uncertain never auto-resumes.
  const decision = deps.sharedRecovery.getSharedRecoveryDecision();
  if (decision.kind === 'ready') return base;
  const recordedAt = Date.now();
  return {
    ...base,
    waiting: {
      orchestratorInstance: 'claw-process',
      nextProbeAt: decision.kind === 'at' ? Math.max(recordedAt, decision.nextProbeAt) : recordedAt,
      recordedAt,
      expiresAt: recordedAt + task.timeoutMs,
      reason: outcome.content,
      execution: outcome.identity,
    },
  };
}
