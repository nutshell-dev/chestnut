/**
 * Test helper for driving the contract verification pipeline without relying on
 * the production agent-facing tool entry point.
 *
 * Phase 1196: `completeSubtask(ContractSystem, )` is no longer a public mutation
 * surface. Tests that used to call it directly now build a `VerificationContext`
 * from the manager's internals and call `runVerificationPipeline` directly.
 *
 * This helper is intentionally test-only and lives outside `src/` so it does not
 * widen the production API.
 */

import type { ContractId, SubtaskId, VerificationResult, VerifierConfig, VerifierResult } from '../../src/core/contract/types.js';
import type { ContractSystem } from '../../src/core/contract/manager.js';
import { runVerificationPipeline, type VerificationContext } from '../../src/core/contract/verification.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { ClawId } from '../../src/foundation/claw-identity/index.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { ToolRegistry } from '../../src/foundation/tools/index.js';
import type { NotifyClawFn } from '../../src/core/contract/verification-types.js';
import type { ContractNotificationSink } from '../../src/core/contract/notification.js';
import type { ProgressData, ContractYaml, ArchiveState } from '../../src/core/contract/types.js';
import type { VerificationAttemptTransition } from '../../src/core/contract/verification-transition-types.js';
import type { SyncCompletionGatewayResult, VerificationGatewayResult } from '../../src/core/contract/verification-types.js';
import type {
  PersistVerificationOutcomeResult,
  VerificationOutcomeIntent,
} from '../../src/core/contract/verification-outcome.js';

type Internals = {
  fs: FileSystem;
  clawDir: string;
  clawId: ClawId;
  audit: AuditLog;
  llm?: LLMOrchestrator;
  notifyClaw: NotifyClawFn;
  toolRegistry: ToolRegistry;
  toolTimeoutMs?: number;
  fsFactory: (baseDir: string) => FileSystem;
  runVerifier?: VerifierConfig['runVerifier'];
  contractDir: (id: ContractId) => Promise<string>;
  loadContractYaml: (id: ContractId) => Promise<ContractYaml | null>;
  getProgress: (id: ContractId) => Promise<ProgressData | null>;
  _submitSyncCompletion: (
    id: ContractId,
    stId: SubtaskId,
    facts: { evidence: string; artifacts?: string[]; at: string },
  ) => Promise<SyncCompletionGatewayResult>;
  _persistVerificationOutcome: (outcome: VerificationOutcomeIntent) => Promise<PersistVerificationOutcomeResult>;
  checkAllCompleted: (id: ContractId, progress: ProgressData) => Promise<boolean>;
  /** Phase 1198 Step B: stable base directory for lifecycle intent store. */
  baseDir: string;
  activeDir: string;
  archiveDir: ArchiveDir;
  _emitContractCompleted: (id: ContractId) => Promise<void>;
  isActiveContract: (id: ContractId) => Promise<boolean>;
  getContractRoot: (id: ContractId) => Promise<string>;
  transitionVerificationAttempt: (id: ContractId, stId: SubtaskId, t: VerificationAttemptTransition) => Promise<VerificationGatewayResult>;
  runScriptVerification: (scriptFile: string, contractAbsDir: string, signal?: AbortSignal) => Promise<VerificationResult>;
  runLLMVerification: (
    promptFile: string,
    contractAbsDir: string,
    contractId: ContractId,
    subtaskId: SubtaskId,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
    signal?: AbortSignal,
  ) => Promise<VerificationResult>;
  _registerVerifierController: (contractId: ContractId, controller: AbortController, promise: Promise<unknown>) => void;
  _unregisterVerifierController: (contractId: ContractId, controller: AbortController) => void;
  runContractVerifier: (config: any) => Promise<VerifierResult>;
  _abortContractVerifiers: (id: ContractId, reason: string) => void;
};

function buildVerificationContext(manager: ContractSystem, signal?: AbortSignal): VerificationContext {
  const self = manager as unknown as Internals;
  return {
    fs: self.fs,
    audit: self.audit,
    clawDir: self.clawDir,
    clawId: self.clawId,
    notifyClaw: self.notifyClaw,
    llm: self.llm,
    contractDir: (id) => self.contractDir(id),
    loadContractYaml: (id) => self.loadContractYaml(id),
    getProgress: (id) => self.getProgress(id),
    submitSyncCompletion: (id, stId, facts) => self._submitSyncCompletion(id, stId, facts),
    persistVerificationOutcome: (outcome) => self._persistVerificationOutcome(outcome),
    checkAllSubtasksCompleted: (id, p) => self.checkAllCompleted(id, p),
    // Mirror manager._verificationCtx(): without this the abort throws TypeError
    // inside archiveAndEmit and emits a spurious abort-failed event.
    abortContractVerifiers: (id, reason) => self._abortContractVerifiers(id, reason),
    baseDir: self.clawDir,
    activeDir: self.activeDir,
    archiveDir: self.archiveDir,
    emitContractCompleted: (id) => self._emitContractCompleted(id),
    isActiveContract: (id) => self.isActiveContract(id),
    getContractRoot: (id) => self.getContractRoot(id),
    transitionVerificationAttempt: (id, stId, t) => self.transitionVerificationAttempt(id, stId, t),
    onNotify: (event) => (manager as unknown as { onNotify?: ContractNotificationSink }).onNotify?.(event),
    signal,
    runScriptVerification: function(scriptFile: string, contractAbsDir: string) {
      return self.runScriptVerification(scriptFile, contractAbsDir, this.signal);
    },
    runLLMVerification: function(
      promptFile: string,
      contractAbsDir: string,
      contractId: ContractId,
      subtaskId: SubtaskId,
      subtaskDesc: string,
      evidence: string,
      artifacts: string[],
    ) {
      return self.runLLMVerification(promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts, this.signal);
    },
    toolRegistry: self.toolRegistry,
    toolTimeoutMs: self.toolTimeoutMs,
    registerController: (contractId, controller, promise) => {
      self._registerVerifierController(contractId, controller, promise);
    },
    unregisterController: (contractId, controller) => {
      self._unregisterVerifierController(contractId, controller);
    },
    runVerifierWithCancel: async function(contractId, config) {
      const controller = new AbortController();
      const signal = this.signal;
      const effectiveSignal = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      const promise = self.runContractVerifier({ ...config, signal: effectiveSignal, contractId, fsFactory: self.fsFactory, runVerifier: self.runVerifier });
      self._registerVerifierController(contractId, controller, promise);
      try {
        return await promise;
      } finally {
        self._unregisterVerifierController(contractId, controller);
      }
    },
  };
}

export async function completeSubtask(
  manager: ContractSystem,
  params: {
    contractId: ContractId;
    subtaskId: SubtaskId;
    evidence: string;
    artifacts?: string[];
  },
): Promise<VerificationResult> {
  return runVerificationPipeline(buildVerificationContext(manager), params);
}

export function createManagerVerificationContext(
  manager: ContractSystem,
  signal?: AbortSignal,
): VerificationContext {
  return buildVerificationContext(manager, signal);
}
