/**
 * @module L3.SubAgent.ExecutionTypes
 * Persistent execution identity and observation contracts.
 *
 * Step C provides persistence and references; Step D connects owned execution
 * without transferring ATS/Shadow/Contract business ownership.
 */

import type { AtomicWriteResult, FileSystem } from '../../foundation/fs/index.js';
import type {
  ProcessRef,
  ProcessRefCapture,
  ProcessRefObservation,
} from '../../foundation/process-exec/index.js';

export type SubagentJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SubagentJsonValue[]
  | { readonly [key: string]: SubagentJsonValue };

export interface SubagentExecutionLocation {
  readonly runId: string;
  readonly resultDir: string;
}

export interface SubagentExecutionIdentity extends SubagentExecutionLocation {
  /** Opaque per-attempt value. Consumers must not parse or infer ordering from it. */
  readonly attemptId: string;
}

export interface SubagentExecutionQuery extends SubagentExecutionLocation {
  /** Omit to read the latest attempt; legacy observations have no attempt id. */
  readonly attemptId?: string;
}

export type SubagentExecutionState =
  | 'prepared'
  | 'running'
  | 'stopping'
  | 'settling'
  | 'settled'
  | 'recovery_required';

export type SubagentOutcomeKind = 'completed' | 'interrupted' | 'failed';
export type SubagentRecoveryFact = 'none' | 'shared_dependency' | 'uncertain_side_effect';

export interface SubagentExecutionWriteEvidence {
  readonly path: string;
  readonly kind: AtomicWriteResult['kind'] | 'failed' | 'unavailable' | 'unknown';
  readonly persisted: boolean;
  readonly durable: boolean;
  readonly error?: string;
}

export interface SubagentExecutionDegraded {
  readonly stage: 'event' | 'state' | 'outcome' | 'artifact';
  readonly artifact: string;
  readonly error: string;
}

export interface SubagentArtifactReference {
  readonly kind: string;
  readonly path: string;
}

export interface SubagentOutcomeDocument {
  readonly schema_version: 1;
  readonly runId: string;
  readonly resultDir: string;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly sequence: number;
  readonly kind: SubagentOutcomeKind;
  readonly content: string;
  readonly evidenceRef?: string;
  readonly rawResult?: SubagentJsonValue;
  readonly cause?: unknown;
  readonly recovery: SubagentRecoveryFact;
  readonly artifacts: readonly SubagentArtifactReference[];
  readonly degraded: readonly SubagentExecutionDegraded[];
  readonly committedAtMs: number;
}

export interface SubagentExecutionPersistence {
  readonly executionDir: string;
  readonly outcome: SubagentExecutionWriteEvidence;
  readonly state?: SubagentExecutionWriteEvidence;
  readonly events: readonly SubagentExecutionWriteEvidence[];
  readonly stops: readonly SubagentExecutionWriteEvidence[];
}

export interface SubagentFinalOutcome {
  readonly identity: SubagentExecutionIdentity;
  readonly kind: SubagentOutcomeKind;
  readonly content: string;
  readonly evidenceRef?: string;
  readonly rawResult?: SubagentJsonValue;
  readonly cause?: unknown;
  readonly recovery: SubagentRecoveryFact;
  readonly artifacts: readonly SubagentArtifactReference[];
  readonly degraded: readonly SubagentExecutionDegraded[];
  readonly persistence: SubagentExecutionPersistence;
}

export interface SubagentExecutionView {
  readonly identity: SubagentExecutionIdentity;
  readonly ordinal: number;
  /** Monotonic within this attempt; also used to de-duplicate observer replay. */
  readonly sequence: number;
  readonly state: SubagentExecutionState;
  readonly reason?: unknown;
  readonly outcome?: SubagentFinalOutcome;
}

export interface SubagentStopReceipt {
  readonly identity: SubagentExecutionIdentity;
  readonly accepted: boolean;
  readonly state: SubagentExecutionState;
  readonly reason: unknown;
  readonly persisted: boolean;
  readonly durable: boolean;
  readonly persistence: SubagentExecutionWriteEvidence;
  readonly statePersistence?: SubagentExecutionWriteEvidence;
}

export interface SubagentExecutionRef {
  readonly identity: SubagentExecutionIdentity;
  readonly completion: Promise<SubagentFinalOutcome>;
  read(): Promise<SubagentExecutionView>;
  observe(listener: (view: SubagentExecutionView) => void): () => void;
  requestStop(reason: unknown): Promise<SubagentStopReceipt>;
}

export interface SubagentExecutionObserver {
  readonly identity: SubagentExecutionIdentity;
  read(): Promise<SubagentExecutionView>;
  observe(listener: (view: SubagentExecutionView) => void): () => void;
}

interface SubagentObservationBase {
  readonly runId: string;
  readonly resultDir: string;
}

export type SubagentObservation =
  | (SubagentObservationBase & {
      readonly kind: 'found';
      readonly identity: SubagentExecutionIdentity;
      readonly view: SubagentExecutionView;
      readonly ref: SubagentExecutionObserver;
      readonly owner: 'alive' | 'gone' | 'settled';
    })
  | (SubagentObservationBase & {
      readonly kind: 'owner_unavailable';
      readonly identity: SubagentExecutionIdentity;
      readonly view: SubagentExecutionView;
      readonly ref: SubagentExecutionObserver;
      readonly reason: string;
    })
  | (SubagentObservationBase & {
      readonly kind: 'legacy';
      readonly artifacts: readonly string[];
    })
  | (SubagentObservationBase & { readonly kind: 'not_found' })
  | (SubagentObservationBase & {
      readonly kind: 'corrupt';
      readonly path?: string;
      readonly reason: string;
    });

export interface SubagentStartRequest extends SubagentExecutionLocation {
  readonly input: unknown;
  readonly signal?: AbortSignal;
  /** Absolute total deadline. Existing attempts keep their original value on attach/resume. */
  readonly deadlineAtMs?: number;
}

export interface SubagentResumeRequest extends SubagentStartRequest {
  readonly previousAttemptId: string;
}

export interface SubagentRunner {
  start(request: SubagentStartRequest): Promise<SubagentExecutionRef>;
  /** Read/connect only. This method never acquires a claim or starts execution. */
  open(identity: SubagentExecutionQuery): Promise<SubagentObservation>;
  resume(request: SubagentResumeRequest): Promise<SubagentExecutionRef>;
}

export interface SubagentProcessCapability {
  captureCurrentProcessRef(): ProcessRefCapture;
  inspectProcessRef(ref: ProcessRef): ProcessRefObservation;
}

export interface SubagentExecutionAuditWriter {
  write(event: string, ...columns: unknown[]): void;
}

export interface SubagentExecutionOptions {
  readonly fs: FileSystem;
  readonly process?: SubagentProcessCapability;
  readonly auditWriter?: SubagentExecutionAuditWriter;
  readonly onObserverError?: (error: unknown, identity: SubagentExecutionIdentity) => void;
  /** Test/embedding seams; production defaults are UUID and wall-clock time. */
  readonly newAttemptId?: () => string;
  readonly now?: () => number;
}

export interface SubagentTransition {
  readonly state: Exclude<SubagentExecutionState, 'settled'>;
  readonly reason?: unknown;
}

export interface SubagentSettlementInput {
  readonly kind: SubagentOutcomeKind;
  readonly content: string;
  readonly evidenceRef?: string;
  readonly rawResult?: SubagentJsonValue;
  readonly cause?: unknown;
  readonly recovery?: SubagentRecoveryFact;
  readonly artifacts?: readonly SubagentArtifactReference[];
  readonly degraded?: readonly SubagentExecutionDegraded[];
}
