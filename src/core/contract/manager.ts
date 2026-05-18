/**
 * @module L4.ContractSystem
 * Contract lifecycle orchestrator — thin class / 装配 + delegate
 *
 * 业务逻辑下沉到 sub-module:
 * - types.ts        / 5 interface
 * - lock.ts         / lock primitives
 * - discovery.ts    / loadActive/Paused
 * - persistence.ts  / yaml + progress.json fs helpers
 * - verifier-job.ts / runContractVerifier
 * - lifecycle.ts    / pause/resume/cancel/isComplete/moveToArchive
 * - acceptance.ts   / completeSubtask + acceptance pipeline
 *
 * 本 class own:
 * - 装配（ctx 构造）
 * - public API method（thin delegate）
 * - private contractDir helper（路径解析跨 active/paused/archive）
 * - getProgress（读 progress.json）
 * - create（contract 创建）
 * - setOnNotify + onContractCompleted + _emitContractCompleted（事件）
 */

import * as yaml from 'js-yaml';
import { randomUUID } from 'crypto';
import * as path from 'path';

import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { Contract, ContractStatus, SubtaskStatus, LastFailedFeedback, AcceptanceFailedNotification } from '../../types/contract.js';
import { ToolError, ToolTimeoutError, isProgrammingBug } from '../../types/errors.js';
import { InboxWriter } from '../../foundation/messaging/index.js';
import { type AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import { AUDIT_PREVIEW_LEN } from '../../foundation/audit/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_PAUSED_DIR, CONTRACT_ARCHIVE_DIR } from './dirs.js';
import { UUID_SHORT_LEN } from '../../constants.js';

import type {
  ContractYaml, ProgressData, AcceptanceResult, VerifierConfig, VerifierResult,
} from './types.js';
import {
  acquireLock, unlinkStaleLock, releaseLock, withProgressLock as wpl,
  type LockContext,
} from './lock.js';
import { loadActiveContract, loadPausedContract, type DiscoveryContext } from './discovery.js';
import {
  loadContractYaml as loadYaml, readContractYamlRaw as readYaml,
  loadContract as loadCt, saveProgress as saveProg,
  checkAllSubtasksCompleted,
  type PersistenceContext,
} from './persistence.js';
import { runContractVerifier } from './verifier-job.js';
import {
  pauseContract, resumeContract, cancelContract,
  isContractComplete, moveContractToArchive,
  type LifecycleContext,
} from './lifecycle.js';
import {
  runAcceptancePipeline, runAcceptanceInBackground, completeSubtaskSync,
  writeAcceptanceInbox, writeAcceptanceError, formatRejectionFeedback,
  runScriptAcceptance as runScriptAcceptanceFn,
  runLLMAcceptance as runLLMAcceptanceFn,
  type AcceptanceContext,
} from './acceptance.js';

// Contract default value constants
const CONTRACT_DEFAULTS = {
  schema_version: 1,
  auth_level: 'auto' as const,
};

export {
  type ContractYaml,
  type ProgressData,
  type AcceptanceResult,
  type VerifierConfig,
  type VerifierResult,
};

export class ContractSystem {
  private fs: FileSystem;
  private clawDir: string;
  private readonly clawId: string;
  private readonly audit: AuditLog;
  private llm?: LLMOrchestrator;
  private toolRegistry: ToolRegistry;
  private toolTimeoutMs?: number;

  private activeDir = CONTRACT_ACTIVE_DIR;
  private pausedDir = CONTRACT_PAUSED_DIR;
  private archiveDir = CONTRACT_ARCHIVE_DIR;
  onNotify?: (type: string, data: Record<string, unknown>) => void;

  private contractCompletedCallbacks: Set<(contractId: string) => Promise<void>> = new Set();

  /**
   * phase 1020 (r124 C fork): per-contract active verifier controllers
   * cancelContract 触发后 abort 所有 controller / 真 propagate verifier subagent abort
   * 反 phase 993 D.1 dead field
   */
  private _activeContractControllers = new Map<string, Set<AbortController>>();

  private _registerVerifierController(contractId: string, ctrl: AbortController): void {
    let s = this._activeContractControllers.get(contractId);
    if (!s) {
      s = new Set();
      this._activeContractControllers.set(contractId, s);
    }
    s.add(ctrl);
  }

  private _unregisterVerifierController(contractId: string, ctrl: AbortController): void {
    const s = this._activeContractControllers.get(contractId);
    if (!s) return;
    s.delete(ctrl);
    if (s.size === 0) this._activeContractControllers.delete(contractId);
  }

  private _abortContractVerifiers(contractId: string, reason: string): void {
    const s = this._activeContractControllers.get(contractId);
    if (!s) return;
    const err = new Error(`contract ${contractId} cancelled: ${reason}`);
    for (const c of s) {
      try {
        c.abort(err);
      } catch (abortErr) {
        // unsafe abort: 容错防破 cancelContract 主流程
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.CANCELLED,
          contractId,
          `abort_verifier_failed: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
        );
      }
    }
  }

  constructor(
    clawDir: string,
    clawId: string,
    fs: FileSystem,
    audit: AuditLog,
    llm?: LLMOrchestrator,
    toolRegistry?: ToolRegistry,
    toolTimeoutMs?: number,
  ) {
    this.clawDir = clawDir;
    this.clawId = clawId;
    this.fs = fs;
    this.audit = audit;
    this.llm = llm;
    if (!toolRegistry) {
      throw new Error('ContractSystem: toolRegistry required (phase 704 / verifier subagent toolset injection)');
    }
    this.toolRegistry = toolRegistry;
    this.toolTimeoutMs = toolTimeoutMs;
  }

  setOnNotify(cb: (type: string, data: Record<string, unknown>) => void): void {
    this.onNotify = cb;
  }

  // ============================================================================
  // contractDir helper
  // ============================================================================

  private async contractDir(contractId: string): Promise<string> {
    if (await this.fs.exists(`${this.activeDir}/${contractId}/progress.json`)) {
      return this.activeDir;
    }
    if (await this.fs.exists(`${this.pausedDir}/${contractId}/progress.json`)) {
      return this.pausedDir;
    }
    if (await this.fs.exists(`${this.archiveDir}/${contractId}/progress.json`)) {
      return this.archiveDir;
    }
    throw new ToolError(`Contract "${contractId}" not found`);
  }

  // ============================================================================
  // ctx 装配 helper
  // ============================================================================

  private _lockCtx(): LockContext {
    return { fs: this.fs, audit: this.audit };
  }

  private _persistenceCtx(): PersistenceContext {
    return {
      fs: this.fs,
      audit: this.audit,
      contractDir: (id) => this.contractDir(id),
      getProgress: (id) => this.getProgress(id),
    };
  }

  private _discoveryCtx(): DiscoveryContext {
    return {
      fs: this.fs,
      audit: this.audit,
      loadContract: (id) => this.loadContract(id),
    };
  }

  private _lifecycleCtx(): LifecycleContext {
    return {
      ...this._lockCtx(),
      activeDir: this.activeDir,
      pausedDir: this.pausedDir,
      archiveDir: this.archiveDir,
      contractDir: (id) => this.contractDir(id),
      loadContract: (id) => this.loadContract(id),
      getProgress: (id) => this.getProgress(id),
      saveProgress: (id, p) => this.saveProgress(id, p),
      checkAllSubtasksCompleted: (id, p) => this.checkAllCompleted(id, p),
      abortContractVerifiers: (id, reason) => this._abortContractVerifiers(id, reason),
    };
  }

  private _acceptanceCtx(): AcceptanceContext {
    return {
      ...this._lockCtx(),
      clawDir: this.clawDir,
      clawId: this.clawId,
      llm: this.llm,
      contractDir: (id) => this.contractDir(id),
      loadContractYaml: (id) => this.loadContractYaml(id),
      getProgress: (id) => this.getProgress(id),
      saveProgress: (id, p) => this.saveProgress(id, p),
      checkAllSubtasksCompleted: (id, p) => this.checkAllCompleted(id, p),
      moveContractToArchive: (id) => this.moveToArchive(id),
      emitContractCompleted: (id) => this._emitContractCompleted(id),
      onNotify: this.onNotify,
      runScriptAcceptance: (scriptFile, contractAbsDir) => this.runScriptAcceptance(scriptFile, contractAbsDir),
      runLLMAcceptance: (promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts) =>
        this.runLLMAcceptance(promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts),
      withProgressLock: (contractId, fn) => this.withProgressLock(contractId, fn),
      toolRegistry: this.toolRegistry,
      toolTimeoutMs: this.toolTimeoutMs,
      runVerifierWithCancel: async (contractId, config) => {
        const controller = new AbortController();
        this._registerVerifierController(contractId, controller);
        try {
          return await runContractVerifier({ ...config, signal: controller.signal });
        } finally {
          this._unregisterVerifierController(contractId, controller);
        }
      },
    };
  }

  // ============================================================================
  // public API method（thin delegate to sub-module function）
  // ============================================================================

  // Discovery
  async loadActive(): Promise<Contract | null> {
    return loadActiveContract(this._discoveryCtx(), this.activeDir);
  }

  async loadPaused(): Promise<Contract | null> {
    return loadPausedContract(this._discoveryCtx(), this.pausedDir);
  }

  // Acceptance
  async completeSubtask(params: {
    contractId: string;
    subtaskId: string;
    evidence: string;
    artifacts?: string[];
  }): Promise<AcceptanceResult> {
    return runAcceptancePipeline(this._acceptanceCtx(), params);
  }

  // Lifecycle
  async pause(contractId: string, checkpointNote: string): Promise<void> {
    return pauseContract(this._lifecycleCtx(), contractId, checkpointNote);
  }

  async resume(contractId: string): Promise<Contract> {
    return resumeContract(this._lifecycleCtx(), contractId);
  }

  async cancel(contractId: string, reason: string): Promise<void> {
    return cancelContract(this._lifecycleCtx(), contractId, reason);
  }

  async isComplete(contractId: string): Promise<boolean> {
    return isContractComplete(this._lifecycleCtx(), contractId);
  }

  // Persistence
  public async readContractYamlRaw(contractId: string): Promise<string> {
    return readYaml(this._persistenceCtx(), contractId);
  }

  // Events
  onContractCompleted(cb: (contractId: string) => Promise<void>): () => void {
    this.contractCompletedCallbacks.add(cb);
    return () => { this.contractCompletedCallbacks.delete(cb); };
  }

  private async _emitContractCompleted(contractId: string): Promise<void> {
    for (const cb of this.contractCompletedCallbacks) {
      try {
        await cb(contractId);
      } catch (e) {
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_COMPLETED_HANDLER_FAILED,
          `contractId=${contractId}`,
          `error=${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // ============================================================================
  // class own logic（不下沉的部分）
  // ============================================================================

  async create(contractYaml: ContractYaml): Promise<string> {
    const contractId = contractYaml.id || `${Date.now()}-${randomUUID().slice(0, UUID_SHORT_LEN)}`;

    if (!contractYaml.subtasks || contractYaml.subtasks.length === 0) {
      throw new Error('Contract must have at least one subtask');
    }

    for (const a of contractYaml.acceptance ?? []) {
      if (a.type === 'script' && !('script_file' in a)) {
        throw new Error(
          `acceptance config for subtask "${a.subtask_id}": type "script" requires "script_file"`
        );
      }
      if (a.type === 'llm' && !('prompt_file' in a)) {
        throw new Error(
          `acceptance config for subtask "${a.subtask_id}": type "llm" requires "prompt_file"`
        );
      }
    }

    const seenSubtaskIds = new Set<string>();
    for (const a of contractYaml.acceptance ?? []) {
      if (seenSubtaskIds.has(a.subtask_id)) {
        throw new Error(
          `acceptance config: duplicate subtask_id "${a.subtask_id}" — each subtask can only have one acceptance entry`
        );
      }
      seenSubtaskIds.add(a.subtask_id);
    }

    const existing = await this.loadActive();
    if (existing && existing.id !== contractId) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.ARCHIVE_STARTED,
        `old=${existing.id}`,
        `new=${contractId}`,
      );
      try {
        await this.moveToArchive(existing.id);
      } catch (err) {
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED,
          `old=${existing.id}`,
          `new=${contractId}`,
          `reason=${err instanceof Error ? err.message : String(err)}`,
        );
        // 不阻断 create / 旧 contract 残留 / Watchdog 可观察 audit
      }
    }

    await this.fs.ensureDir(`${this.activeDir}/${contractId}`);

    const content = yaml.dump({
      schema_version: contractYaml.schema_version ?? CONTRACT_DEFAULTS.schema_version,
      id: contractId,
      title: contractYaml.title,
      background: contractYaml.background,
      goal: contractYaml.goal,
      expectations: contractYaml.expectations,
      subtasks: contractYaml.subtasks,
      acceptance: contractYaml.acceptance ?? [],
      auth_level: contractYaml.auth_level ?? CONTRACT_DEFAULTS.auth_level,
    });
    await this.fs.writeAtomic(`${this.activeDir}/${contractId}/contract.yaml`, content);

    const progress: ProgressData = {
      contract_id: contractId,
      status: 'running',
      subtasks: Object.fromEntries(
        contractYaml.subtasks.map(st => [st.id, { status: 'todo' as SubtaskStatus }])
      ),
      started_at: new Date().toISOString(),
      checkpoint: null,
    };
    try {
      await this.fs.writeAtomic(
        `${this.activeDir}/${contractId}/progress.json`,
        JSON.stringify(progress, null, 2)
      );
    } catch (err) {
      await this.fs.removeDir(`${this.activeDir}/${contractId}`).catch((deleteErr) => {
        if (isProgrammingBug(deleteErr)) {
          this.audit.write(
            CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW,
            `context=ContractSystem.rollbackCleanup`,
            `contractId=${contractId}`,
            `errorType=${deleteErr instanceof Error ? deleteErr.constructor.name : typeof deleteErr}`,
            `error=${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`,
            `stack=${deleteErr instanceof Error ? deleteErr.stack ?? '' : ''}`,
          );
        }
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.ROLLBACK_FAILED,
          `contractId=${contractId}`,
          `error=${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`,
        );
      });
      throw err;
    }

    try {
      this.onNotify?.('contract_created', { contractId, title: contractYaml.title, subtaskCount: contractYaml.subtasks.length });
    } catch (err) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
        `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.audit.write(CONTRACT_AUDIT_EVENTS.CREATED, contractId, `subtasks=${contractYaml.subtasks.length}`, `title=${contractYaml.title}`);
    return contractId;
  }

  async getProgress(contractId: string): Promise<ProgressData> {
    const dir = await this.contractDir(contractId);
    const progressPath = `${dir}/${contractId}/progress.json`;
    const content = await this.fs.read(progressPath);
    const parsed = JSON.parse(content) as { contract_id?: unknown; status?: unknown; subtasks?: unknown };
    if (
      typeof parsed.contract_id !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.subtasks !== 'object' || parsed.subtasks === null
    ) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
        `contractId=${contractId}`,
        `path=${progressPath}`,
        `raw=${content.slice(0, AUDIT_PREVIEW_LEN)}`,
      );
      throw new Error(`progress.json schema invalid for contract ${contractId}`);
    }
    return parsed as ProgressData;
  }

  // ============================================================================
  // private thin delegate（保 method 名 / tests white-box 调用面 + spy 保护）
  // ============================================================================

  private async acquireLock(lockPath: string): Promise<void> {
    return acquireLock(this._lockCtx(), lockPath);
  }

  private async unlinkStaleLock(lockPath: string, reason: string): Promise<boolean> {
    return unlinkStaleLock(this._lockCtx(), lockPath, reason);
  }

  private async releaseLock(lockPath: string): Promise<void> {
    return releaseLock(this._lockCtx(), lockPath);
  }

  private async withProgressLock<T>(contractId: string, fn: () => Promise<T>): Promise<T> {
    const dir = await this.contractDir(contractId);
    return wpl(this._lockCtx(), dir, contractId, fn);
  }

  private async loadContractYaml(contractId: string): Promise<ContractYaml> {
    return loadYaml(this._persistenceCtx(), contractId);
  }

  private async loadContract(contractId: string): Promise<Contract> {
    return loadCt(this._persistenceCtx(), contractId);
  }

  private async saveProgress(contractId: string, progress: ProgressData): Promise<void> {
    return saveProg(this._persistenceCtx(), contractId, progress);
  }

  private async checkAllCompleted(contractId: string, progress: ProgressData): Promise<boolean> {
    return checkAllSubtasksCompleted(this._persistenceCtx(), contractId, progress);
  }

  private async moveToArchive(contractId: string): Promise<void> {
    return moveContractToArchive(this._lifecycleCtx(), contractId);
  }

  private async _runVerifierSubagent(config: VerifierConfig): Promise<VerifierResult> {
    return runContractVerifier(config);
  }

  private async _completeSubtaskSync(
    contractId: string,
    subtaskId: string,
    evidence: string,
    artifacts?: string[],
  ): Promise<AcceptanceResult> {
    return completeSubtaskSync(this._acceptanceCtx(), contractId, subtaskId, evidence, artifacts);
  }

  private async _runAcceptanceInBackground(
    params: { contractId: string; subtaskId: string; evidence: string; artifacts?: string[] },
    contractYaml: ContractYaml,
    acceptanceConfig: { subtask_id: string; type: 'script'; script_file?: string } | { subtask_id: string; type: 'llm'; prompt_file?: string },
  ): Promise<void> {
    return runAcceptanceInBackground(this._acceptanceCtx(), params, contractYaml, acceptanceConfig);
  }

  private _writeAcceptanceInbox(
    contractId: string,
    subtaskId: string,
    verdict: 'passed' | 'rejected',
    allCompleted: boolean,
    feedback?: string,
    retryCount?: number,
  ): void {
    return writeAcceptanceInbox(this._acceptanceCtx(), contractId, subtaskId, verdict, allCompleted, feedback, retryCount);
  }

  async _writeAcceptanceError(contractId: string, subtaskId: string, error: unknown): Promise<void> {
    return writeAcceptanceError(this._acceptanceCtx(), contractId, subtaskId, error);
  }

  private formatRejectionFeedback(
    subtaskId: string,
    subtaskDesc: string,
    reason: string,
    issues: string[],
    retryCount: number,
    maxRetries: number,
    acceptanceType: string,
    acceptanceFile: string,
  ): string {
    return formatRejectionFeedback(subtaskId, subtaskDesc, reason, issues, retryCount, maxRetries, acceptanceType, acceptanceFile);
  }

  private async runScriptAcceptance(scriptFile: string, contractAbsDir: string): Promise<AcceptanceResult> {
    return runScriptAcceptanceFn(this._acceptanceCtx(), scriptFile, contractAbsDir);
  }

  private async runLLMAcceptance(
    promptFile: string,
    contractAbsDir: string,
    contractId: string,
    subtaskId: string,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
  ): Promise<AcceptanceResult> {
    return runLLMAcceptanceFn(this._acceptanceCtx(), promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts);
  }
}
