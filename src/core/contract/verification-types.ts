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
import type { ContractId } from './types.js';



export interface VerificationContext extends LockContext {
  clawDir: string;
  clawId: ClawId;
  llm?: LLMOrchestrator;
  contractDir: (contractId: ContractId) => Promise<string>;
  loadContractYaml: (contractId: ContractId) => Promise<ContractYaml>;
  getProgress: (contractId: ContractId) => Promise<ProgressData>;
  saveProgress: (contractId: ContractId, progress: ProgressData) => Promise<void>;
  checkAllSubtasksCompleted: (contractId: ContractId, progress: ProgressData) => Promise<boolean>;
  moveContractToArchive: (contractId: ContractId) => Promise<void>;
  emitContractCompleted: (contractId: ContractId) => Promise<void>;
  onNotify?: (type: string, data: Record<string, unknown>) => void;
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
  withProgressLock: <T>(contractId: ContractId, fn: () => Promise<T>) => Promise<T>;
  toolRegistry: ToolRegistry;
  runVerifierWithCancel: (contractId: ContractId, config: Omit<VerifierConfig, 'signal'>) => Promise<VerifierResult>;
  toolTimeoutMs?: number;
}
