/**
 * @module L4.ContractSystem.Verification.Types
 * Verification type exports to break circular imports within contract verification cluster.
 * Extracted in phase 1314 (cluster #3 of 5 cleanup roadmap).
 */

import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { ContractYaml, ProgressData, VerificationResult, VerifierConfig, VerifierResult, SubtaskId } from './types.js';
import { type LockContext } from './lock.js';
import type { ClawId } from '../../foundation/identity/index.js';
import type { ContractId, ChestnutRoot } from '../../foundation/identity/index.js';
import { type ClawDir } from '../../foundation/identity/index.js';
import type { VerificationMutex } from './verification-mutex.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { InboxMessageOptionsBase } from '../../foundation/messaging/inbox-writer.js';

/**
 * phase 19 Step C: notifyClaw injection point (DIP).
 * Optional — default falls back to direct foundation/messaging.notifyClaw import.
 */
export type NotifyClawFn = (
  fs: FileSystem,
  chestnutRoot: ChestnutRoot,
  targetClawId: string,
  message: InboxMessageOptionsBase,
  audit: AuditLog,
) => void;



/**
 * phase 19 Step A: VerificationContext split into 3 role interfaces (ISP).
 * Composed via `&` intersection — runtime ctx instance unchanged, structurally compatible.
 */

export interface VerificationLockContext extends LockContext {
  withProgressLock: <T>(contractId: ContractId, fn: () => Promise<T>) => Promise<T>;
  /** phase 1465: per-ContractSystem instance race guard for verification pipeline (ML#3 + Tier 1 flaky_test_zero_tolerance) */
  verificationMutex: VerificationMutex;
}

export interface VerificationContractContext {
  clawDir: ClawDir;
  clawId: ClawId;
  /** phase 1389: ctx-injected chestnutRoot (single truth source, no heuristic derivation) */
  chestnutRoot: ChestnutRoot;
  /** phase 19 Step C: optional notifyClaw injection (DIP). Default = foundation/messaging direct call. */
  notifyClaw?: NotifyClawFn;
  contractDir: (contractId: ContractId) => Promise<string>;
  loadContractYaml: (contractId: ContractId) => Promise<ContractYaml>;
  getProgress: (contractId: ContractId) => Promise<ProgressData>;
  saveProgress: (contractId: ContractId, progress: ProgressData) => Promise<void>;
  checkAllSubtasksCompleted: (contractId: ContractId, progress: ProgressData) => Promise<boolean>;
  moveContractToArchive: (contractId: ContractId) => Promise<void>;
  emitContractCompleted: (contractId: ContractId) => Promise<void>;
}

export interface VerificationExecutionContext {
  llm?: LLMOrchestrator;
  toolRegistry: ToolRegistry;
  toolTimeoutMs?: number;
  runScriptVerification: (scriptFile: string, contractAbsDir: ClawDir) => Promise<VerificationResult>;
  runLLMVerification: (
    promptFile: string,
    contractAbsDir: ClawDir,
    contractId: ContractId,
    subtaskId: SubtaskId,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
  ) => Promise<VerificationResult>;
  runVerifierWithCancel: (contractId: ContractId, config: Omit<VerifierConfig, 'signal' | 'chestnutRoot'>) => Promise<VerifierResult>;
  onNotify?: (type: string, data: Record<string, unknown>) => void;
}

export type VerificationContext =
  & VerificationLockContext
  & VerificationContractContext
  & VerificationExecutionContext;
