/**
 * @module L4.ContractSystem.Verification.Types
 * Verification type exports to break circular imports within contract verification cluster.
 * Extracted in phase 1314 (cluster #3 of 5 cleanup roadmap).
 */

import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { ContractYaml, ProgressData, VerificationResult, VerifierConfig, VerifierResult, SubtaskId, ArchiveDir } from './types.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ContractId } from './types.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import type { InboxMessageOptionsBase } from '../../foundation/messaging/index.js';
import type {
  VerificationAttemptTransition,
} from './verification-transition-types.js';
import type {
  PersistVerificationOutcomeResult,
  VerificationOutcomeIntent,
} from './verification-outcome.js';
import type { ContractNotificationSink } from './notification.js';

/**
 * phase 95: pre-bound notifyClaw — caller (Manager) binds fs + chestnutRoot + audit.
 * Verification (L4) receives a pre-bound callback and knows nothing about path topology.
 */
export type NotifyClawFn = (
  targetClawId: string,
  message: InboxMessageOptionsBase,
) => void;



/**
 * phase 19 Step A: VerificationContext split into 3 role interfaces (ISP).
 * Composed via `&` intersection — runtime ctx instance unchanged, structurally compatible.
 */

interface VerificationContractContext {
  fs: FileSystem;
  audit: AuditLog;
  clawDir: string;
  clawId: ClawId;
  /** phase 95: required pre-bound notifyClaw (caller binds fs + chestnutRoot + audit) */
  notifyClaw: NotifyClawFn;
  contractDir: (contractId: ContractId) => Promise<string>;
  loadContractYaml: (contractId: ContractId) => Promise<ContractYaml | null>;
  getProgress: (contractId: ContractId) => Promise<ProgressData | null>;
  /**
   * Phase 1201 Step B: typed queued sync-completion capability.
   * 替换旧 raw `saveProgress`：verification helper 不再能直接写共享 progress，
   * sync completion 整段 RMW 在 ContractSystem 的 per-contract queue 内 fresh-read。
   */
  submitSyncCompletion: (
    contractId: ContractId,
    subtaskId: SubtaskId,
    facts: { evidence: string; artifacts?: string[]; at: string },
  ) => Promise<SyncCompletionGatewayResult>;
  checkAllSubtasksCompleted: (contractId: ContractId, progress: ProgressData) => Promise<boolean>;
  /**
   * Phase 1201 Step C: durable-first verification outcome persist。
   * background result/error 必须先持久化 immutable outcome，再 queued apply；
   * 崩溃窗口由 boot replay 恢复。
   */
  persistVerificationOutcome: (
    outcome: VerificationOutcomeIntent,
  ) => Promise<PersistVerificationOutcomeResult>;
  /** Phase 1198 Step B: base directory for stable lifecycle intent store. */
  baseDir: string;
  /** Phase 1198 Step B: active container directory. */
  activeDir: string;
  /** Phase 1198 Step B: archive container directory. */
  archiveDir: ArchiveDir;
  /** Phase 1198 Step B: abort active verifiers post terminal commit. */
  abortContractVerifiers: (contractId: ContractId, reason: string) => void;
  /**
   * Phase 1198 Step B: post-commit completed handler callback.
   * Called by verification-lifecycle only after the directory rename commit succeeds.
   */
  emitContractCompleted: (contractId: ContractId) => Promise<void>;
  /**
   * Phase 1136 Step B: layout-neutral active check. Returns true iff the
   * contract resides in an active location (current slot or legacy active dir).
   */
  isActiveContract: (contractId: ContractId) => Promise<boolean>;
  /**
   * Phase 1136 Step B: layout-neutral contract root resolution. Returns the
   * contract root directory relative to clawDir for verifier execution.
   */
  getContractRoot: (contractId: ContractId) => Promise<string>;
  /**
   * Phase 1136 Step B: typed attempt transition. Manager dispatches to the
   * current repository or an equivalent legacy progress mutation.
   */
  transitionVerificationAttempt: (
    contractId: ContractId,
    subtaskId: SubtaskId,
    transition: VerificationAttemptTransition,
  ) => Promise<VerificationGatewayResult>;
}

interface VerificationExecutionContext {
  llm?: LLMOrchestrator;
  toolRegistry: ToolRegistry;
  toolTimeoutMs?: number;
  signal?: AbortSignal;
  exec?: typeof import('../../foundation/process-exec/index.js').exec;
  runScriptVerification: (scriptFile: string, contractAbsDir: string) => Promise<VerificationResult>;
  runLLMVerification: (
    promptFile: string,
    contractAbsDir: string,
    contractId: ContractId,
    subtaskId: SubtaskId,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
  ) => Promise<VerificationResult>;
  runVerifierWithCancel: (contractId: ContractId, config: Omit<VerifierConfig, 'signal' | 'clawsDir'>) => Promise<VerifierResult>;
  /** Phase 965: register an AbortController for a running verifier so cancel/close can abort it */
  registerController?: (contractId: ContractId, controller: AbortController, promise: Promise<unknown>) => void;
  /** Phase 965: unregister a verifier AbortController */
  unregisterController?: (contractId: ContractId, controller: AbortController) => void;
  /** phase 1260: ContractSystem-owned typed notification sink */
  onNotify?: ContractNotificationSink;
}

export type VerificationContext =
  & VerificationContractContext
  & VerificationExecutionContext;

/**
 * Phase 1136 Step B: result of a layout-neutral verification attempt transition.
 * The gateway returns the updated progress projection so callers can compute
 * allCompleted, retry_count and emit notifications without reading disk paths.
 */
export type VerificationGatewayResult =
  | { kind: 'updated'; progress: ProgressData }
  | { kind: 'skipped'; reason: string }
  | { kind: 'late'; expectedAttemptId: string; actualAttemptId?: string };

/**
 * Phase 1201 Step B: result of the queued sync-completion capability.
 * The mutation (fresh-read + validate + save) commits inside the ContractSystem
 * per-contract queue; callers perform post-commit audit/notify/archive side
 * effects based on this result without re-reading progress for decisions.
 */
export type SyncCompletionGatewayResult =
  | { kind: 'completed'; progress: ProgressData; allCompleted: boolean }
  | { kind: 'duplicate' }
  | { kind: 'already_completed' }
  | { kind: 'unknown_subtask'; validIds: string }
  | { kind: 'not_active' };
