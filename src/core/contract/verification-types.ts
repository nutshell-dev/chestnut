/**
 * @module L4.ContractSystem.Verification.Types
 * Verification type exports to break circular imports within contract verification cluster.
 * Extracted in phase 1314 (cluster #3 of 5 cleanup roadmap).
 */

import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { ContractYaml, ProgressData, VerificationResult, VerifierConfig, VerifierResult, SubtaskId, ArchiveState } from './types.js';
import { type LockContext } from './lock.js';
import type { ContractId } from './types.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import type { VerificationMutex } from './verification-mutex.js';
import type { InboxMessageOptionsBase } from '../../foundation/messaging/index.js';

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

export interface VerificationLockContext extends LockContext {
  withProgressLock: <T>(contractId: ContractId, fn: () => Promise<T>) => Promise<T>;
  /** phase 1465: per-ContractSystem instance race guard for verification pipeline (M#3 + Tier 1 flaky_test_zero_tolerance) */
  verificationMutex: VerificationMutex;
}

export interface VerificationContractContext {
  clawDir: string;
  clawId: ClawId;
  /** phase 95: required pre-bound notifyClaw (caller binds fs + chestnutRoot + audit) */
  notifyClaw: NotifyClawFn;
  contractDir: (contractId: ContractId) => Promise<string>;
  loadContractYaml: (contractId: ContractId) => Promise<ContractYaml | null>;
  getProgress: (contractId: ContractId) => Promise<ProgressData | null>;
  saveProgress: (contractId: ContractId, progress: ProgressData, knownDir?: string) => Promise<void>;
  checkAllSubtasksCompleted: (contractId: ContractId, progress: ProgressData) => Promise<boolean>;
  moveContractToArchive: (contractId: ContractId, targetState: ArchiveState) => Promise<void>;
  emitContractCompleted: (contractId: ContractId) => Promise<void>;
}

export interface VerificationExecutionContext {
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
  onNotify?: (type: string, data: Record<string, unknown>) => void;
}

export type VerificationContext =
  & VerificationLockContext
  & VerificationContractContext
  & VerificationExecutionContext;
