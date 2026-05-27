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
 * - verification.ts / completeSubtask + verification pipeline
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

import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { Contract, SubtaskStatus } from '../contract/types.js';
import { ToolError, isProgrammingBug } from '../../foundation/errors.js';
import { type AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import { AUDIT_PREVIEW_LEN } from '../../foundation/constants.js';

import {
  emitContractCancelled,
  emitContractCompletedHandlerFailed,
  emitContractArchiveStarted,
  emitContractMoveArchiveFailed,
  emitContractUnexpectedAsyncThrow,
  emitContractRollbackFailed,
  emitContractRollbackIncomplete,
  emitContractNotifyFailed,
  emitContractCreated,
  emitContractProgressSchemaInvalid,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_PAUSED_DIR, CONTRACT_ARCHIVE_DIR } from './dirs.js';
import { UUID_SHORT_LEN } from '../../constants.js';

import type {
  ContractYaml, ProgressData, VerificationResult, VerifierConfig, VerifierResult,
} from './types.js';
import {
  withProgressLock as wpl,
  type LockContext,
} from './lock.js';
import { loadActiveContract, loadPausedContract, type DiscoveryContext } from './discovery.js';
import {
  loadContractYaml as loadYaml, readContractYamlRaw as readYaml,
  loadContract as loadCt, saveProgress as saveProg,
  checkAllSubtasksCompleted,
  type PersistenceContext,
  PROGRESS_CURRENT_SCHEMA_VERSION,
} from './persistence.js';
import { type ContractId, makeContractId, type SubtaskId } from './types.js';
import type { ClawId } from '../../foundation/identity/index.js';
import { runContractVerifier } from './verifier-job.js';
import {
  pauseContract, resumeContract, cancelContract,
  isContractComplete, moveContractToArchive,
  type LifecycleContext,
} from './lifecycle.js';
import {
  runVerificationPipeline,
  runScriptVerification as runScriptVerificationFn,
  runLLMVerification as runLLMVerificationFn,
  writeVerificationError,
  type VerificationContext,
} from './verification.js';

// Contract default value constants
const CONTRACT_DEFAULTS = {
  schema_version: 1,
  auth_level: 'auto' as const,
};

export {
  type ContractYaml,
  type ProgressData,
  type VerificationResult,
  type VerifierConfig,
  type VerifierResult,
};

export interface ContractSystemDeps {
  clawDir: string;
  clawId: ClawId;
  fs: FileSystem;
  audit: AuditLog;
  llm?: LLMOrchestrator;
  toolRegistry: ToolRegistry;
  toolTimeoutMs?: number;
  fsFactory: (baseDir: string) => FileSystem;
}

export class ContractSystem {
  private fs: FileSystem;
  private clawDir: string;
  private readonly clawId: ClawId;
  private readonly audit: AuditLog;
  private llm?: LLMOrchestrator;
  private toolRegistry: ToolRegistry;
  private toolTimeoutMs?: number;
  private fsFactory: (baseDir: string) => FileSystem;

  private activeDir = CONTRACT_ACTIVE_DIR;
  private pausedDir = CONTRACT_PAUSED_DIR;
  private archiveDir = CONTRACT_ARCHIVE_DIR;
  onNotify?: (type: string, data: Record<string, unknown>) => void;

  private contractCompletedCallbacks: Set<(contractId: ContractId) => Promise<void>> = new Set();

  /**
   * phase 1020 (r124 C fork): per-contract active verifier controllers
   * cancelContract 触发后 abort 所有 controller / 真 propagate verifier subagent abort
   * 反 phase 993 D.1 dead field
   */
  private _activeContractControllers = new Map<string, Set<{ controller: AbortController; promise: Promise<unknown> }>>();

  private _registerVerifierController(contractId: ContractId, ctrl: AbortController, promise: Promise<unknown>): void {
    let s = this._activeContractControllers.get(contractId);
    if (!s) {
      s = new Set();
      this._activeContractControllers.set(contractId, s);
    }
    s.add({ controller: ctrl, promise });
  }

  private _unregisterVerifierController(contractId: ContractId, ctrl: AbortController): void {
    const s = this._activeContractControllers.get(contractId);
    if (!s) return;
    for (const entry of s) {
      if (entry.controller === ctrl) {
        s.delete(entry);
        break;
      }
    }
    if (s.size === 0) this._activeContractControllers.delete(contractId);
  }

  hasActiveVerifiers(contractId: ContractId): boolean {
    const set = this._activeContractControllers.get(contractId);
    return set ? set.size > 0 : false;
  }

  getActiveVerifierCount(): number {
    let total = 0;
    for (const set of this._activeContractControllers.values()) {
      total += set.size;
    }
    return total;
  }

  private _abortContractVerifiers(contractId: ContractId, reason: string): void {
    const s = this._activeContractControllers.get(contractId);
    if (!s) return;
    const err = new Error(`contract ${contractId} cancelled: ${reason}`);
    for (const { controller } of s) {
      try {
        controller.abort(err);
      } catch (abortErr) {
        // unsafe abort: 容错防破 cancelContract 主流程
        emitContractCancelled(
          this.audit,
          {
            contractId,
            abortVerifierFailed: abortErr instanceof Error ? abortErr.message : String(abortErr),
          },
        );
      }
    }
  }

  constructor(deps: ContractSystemDeps) {
    this.clawDir = deps.clawDir;
    this.clawId = deps.clawId;
    this.fs = deps.fs;
    this.audit = deps.audit;
    this.llm = deps.llm;
    this.toolRegistry = deps.toolRegistry;
    this.toolTimeoutMs = deps.toolTimeoutMs;
    this.fsFactory = deps.fsFactory;
  }

  setOnNotify(cb: (type: string, data: Record<string, unknown>) => void): void {
    this.onNotify = cb;
  }

  // ============================================================================
  // contractDir helper
  // ============================================================================

  private async contractDir(contractId: ContractId): Promise<string> {
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

  private _verificationCtx(): VerificationContext {
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
      runScriptVerification: (scriptFile, contractAbsDir) => this.runScriptVerification(scriptFile, contractAbsDir),
      runLLMVerification: (promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts) =>
        this.runLLMVerification(promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts),
      withProgressLock: (contractId, fn) => this.withProgressLock(contractId, fn),
      toolRegistry: this.toolRegistry,
      toolTimeoutMs: this.toolTimeoutMs,
      runVerifierWithCancel: async (contractId, config) => {
        const controller = new AbortController();
        const promise = runContractVerifier({ ...config, signal: controller.signal, contractId, fsFactory: this.fsFactory });
        this._registerVerifierController(contractId, controller, promise);
        try {
          return await promise;
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

  /**
   * boot reconcile / DP「中断恢复 + 持久化一切 + 事后可审计」直接 derive
   * phase 1285 InboxReader.init() 模板 mirror
   */
  async init(): Promise<void> {
    const paused = await this.loadPaused();
    if (paused) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
        `paused_contract_id=${paused.id}`,
        'recovered=true',
      );
    } else {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
        'recovered=false',
      );
    }
  }

  // Verification
  async completeSubtask(params: {
    contractId: ContractId;
    subtaskId: SubtaskId;
    evidence: string;
    artifacts?: string[];
  }): Promise<VerificationResult> {
    return runVerificationPipeline(this._verificationCtx(), params);
  }

  // Lifecycle
  async pause(contractId: ContractId, checkpointNote: string): Promise<void> {
    return pauseContract(this._lifecycleCtx(), contractId, checkpointNote);
  }

  async resume(contractId: ContractId): Promise<Contract> {
    return resumeContract(this._lifecycleCtx(), contractId);
  }

  async cancel(contractId: ContractId, reason: string): Promise<void> {
    return cancelContract(this._lifecycleCtx(), contractId, reason);
  }

  async isComplete(contractId: ContractId): Promise<boolean> {
    return isContractComplete(this._lifecycleCtx(), contractId);
  }

  // Persistence
  public async readContractYamlRaw(contractId: ContractId): Promise<string> {
    return readYaml(this._persistenceCtx(), contractId);
  }

  // Events
  onContractCompleted(cb: (contractId: ContractId) => Promise<void>): () => void {
    this.contractCompletedCallbacks.add(cb);
    return () => { this.contractCompletedCallbacks.delete(cb); };
  }

  private async _emitContractCompleted(contractId: ContractId): Promise<void> {
    for (const cb of this.contractCompletedCallbacks) {
      try {
        await cb(contractId);
      } catch (e) {
        emitContractCompletedHandlerFailed(
          this.audit,
          {
            contractId,
            error: e instanceof Error ? e.message : String(e),
          },
        );
      }
    }
  }

  // ============================================================================
  // class own logic（不下沉的部分）
  // ============================================================================

  async create(contractYaml: ContractYaml): Promise<string> {
    if (contractYaml.id !== undefined && contractYaml.id.trim() === '') {
      throw new Error('contract id must not be empty');
    }
    const contractId = makeContractId(contractYaml.id || `${Date.now()}-${randomUUID().slice(0, UUID_SHORT_LEN)}`);

    // Check uniqueness against archived contracts too
    if (await this.fs.exists(`${this.archiveDir}/${contractId}`)) {
      throw new Error(`contract id ${contractId} already exists in archive`);
    }

    if (!contractYaml.subtasks || contractYaml.subtasks.length === 0) {
      throw new Error('Contract must have at least one subtask');
    }

    for (const a of contractYaml.verification ?? []) {
      if (a.type === 'script' && !('script_file' in a)) {
        throw new Error(
          `verification config for subtask "${a.subtask_id}": type "script" requires "script_file"`
        );
      }
      if (a.type === 'llm' && !('prompt_file' in a)) {
        throw new Error(
          `verification config for subtask "${a.subtask_id}": type "llm" requires "prompt_file"`
        );
      }
    }

    const seenSubtaskIds = new Set<string>();
    for (const a of contractYaml.verification ?? []) {
      if (seenSubtaskIds.has(a.subtask_id)) {
        throw new Error(
          `verification config: duplicate subtask_id "${a.subtask_id}" — each subtask can only have one verification entry`
        );
      }
      seenSubtaskIds.add(a.subtask_id);
    }

    const existing = await this.loadActive();
    if (existing && existing.id !== contractId) {
      emitContractArchiveStarted(
        this.audit,
        { old: existing.id, new: contractId },
      );
      try {
        await this.moveToArchive(makeContractId(existing.id));
      } catch (err) {
        emitContractMoveArchiveFailed(
          this.audit,
          {
            old: existing.id,
            new: contractId,
            reason: err instanceof Error ? err.message : String(err),
          },
        );
        // phase 1038 α-7: throw instead of swallow — state machine invariant「1 active contract per claw」
        // 不可 create new contract while previous archive failed (导致 multi-active state)
        throw new ToolError(
          `Cannot create contract "${contractId}": previous active contract "${existing.id}" archive failed. ` +
          `Manual intervention required: check archive/ dir + retry create. Original error: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
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
      verification: contractYaml.verification ?? [],
      auth_level: contractYaml.auth_level ?? CONTRACT_DEFAULTS.auth_level,
    });
    await this.fs.writeAtomic(`${this.activeDir}/${contractId}/contract.yaml`, content);

    const progress: ProgressData = {
      schema_version: PROGRESS_CURRENT_SCHEMA_VERSION,
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
          emitContractUnexpectedAsyncThrow(
            this.audit,
            {
              context: 'ContractSystem.rollbackCleanup',
              contractId,
              errorType: deleteErr instanceof Error ? deleteErr.constructor.name : typeof deleteErr,
              error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
              stack: deleteErr instanceof Error ? deleteErr.stack ?? '' : '',
            },
          );
        }
        emitContractRollbackFailed(
          this.audit,
          {
            contractId,
            error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
          },
        );
      });
      // verify rollback succeeded
      if (await this.fs.exists(`${this.activeDir}/${contractId}`)) {
        emitContractRollbackIncomplete(
          this.audit,
          {
            contractId,
            remaining: `${this.activeDir}/${contractId}`,
          },
        );
      }
      throw err;
    }

    try {
      this.onNotify?.('contract_created', { contractId, title: contractYaml.title, subtaskCount: contractYaml.subtasks.length });
    } catch (err) {
      emitContractNotifyFailed(
        this.audit,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
    emitContractCreated(
      this.audit,
      {
        contractId,
        subtasks: contractYaml.subtasks.length,
        title: contractYaml.title,
      },
    );
    return contractId;
  }

  async getProgress(contractId: ContractId): Promise<ProgressData> {
    const dir = await this.contractDir(contractId);
    const progressPath = `${dir}/${contractId}/progress.json`;
    const content = await this.fs.read(progressPath);
    const parsed = JSON.parse(content) as { schema_version?: unknown; contract_id?: unknown; status?: unknown; subtasks?: unknown };

    // NEW phase 1134 / schema_version invariant (mirror phase 1019 contract.yaml)
    if (parsed.schema_version !== undefined &&
        (typeof parsed.schema_version !== 'number' || parsed.schema_version > PROGRESS_CURRENT_SCHEMA_VERSION)) {
      emitContractProgressSchemaInvalid(
        this.audit,
        {
          contractId,
          path: progressPath,
          reason: 'unknown_schema_version',
          actual: String(parsed.schema_version),
          current: PROGRESS_CURRENT_SCHEMA_VERSION,
        },
      );
      throw new Error(`progress.json unknown schema_version ${String(parsed.schema_version)} for contract ${contractId} (current=${PROGRESS_CURRENT_SCHEMA_VERSION})`);
    }

    if (
      typeof parsed.contract_id !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.subtasks !== 'object' || parsed.subtasks === null
    ) {
      emitContractProgressSchemaInvalid(
        this.audit,
        {
          contractId,
          path: progressPath,
          raw: content.slice(0, AUDIT_PREVIEW_LEN),
        },
      );
      throw new Error(`progress.json schema invalid for contract ${contractId}`);
    }
    return parsed as ProgressData;
  }

  // ============================================================================
  // private thin delegate（保 method 名 / tests white-box 调用面 + spy 保护）
  // ============================================================================

  private async withProgressLock<T>(contractId: ContractId, fn: () => Promise<T>): Promise<T> {
    const dir = await this.contractDir(contractId);
    return wpl(this._lockCtx(), dir, contractId, fn);
  }

  private async loadContractYaml(contractId: ContractId): Promise<ContractYaml> {
    return loadYaml(this._persistenceCtx(), contractId);
  }

  async _writeVerificationError(contractId: ContractId, subtaskId: SubtaskId, error: unknown): Promise<void> {
    return writeVerificationError(this._verificationCtx(), contractId, subtaskId, error);
  }

  private async loadContract(contractId: ContractId): Promise<Contract> {
    return loadCt(this._persistenceCtx(), contractId);
  }

  private async saveProgress(contractId: ContractId, progress: ProgressData): Promise<void> {
    return saveProg(this._persistenceCtx(), contractId, progress);
  }

  private async checkAllCompleted(contractId: ContractId, progress: ProgressData): Promise<boolean> {
    return checkAllSubtasksCompleted(this._persistenceCtx(), contractId, progress);
  }

  private async moveToArchive(contractId: ContractId): Promise<void> {
    return moveContractToArchive(this._lifecycleCtx(), contractId);
  }

  private async runScriptVerification(scriptFile: string, contractAbsDir: string): Promise<VerificationResult> {
    return runScriptVerificationFn(this._verificationCtx(), scriptFile, contractAbsDir);
  }

  private async runLLMVerification(
    promptFile: string,
    contractAbsDir: string,
    contractId: ContractId,
    subtaskId: SubtaskId,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
  ): Promise<VerificationResult> {
    return runLLMVerificationFn(this._verificationCtx(), promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts);
  }

  /**
   * phase 1217 (r131 C fork): true disposable / abort all active verifier controllers
   * phase 1335 (r138 F fork): async close / await verifier termination promises
   */
  async close(): Promise<void> {
    const terminationPromises: Promise<unknown>[] = [];
    for (const [, entries] of this._activeContractControllers) {
      for (const { controller, promise } of entries) {
        try {
          controller.abort();
        } catch {
          // silent: abort 失败不影响 dispose 流程 / best-effort cleanup
        }
        terminationPromises.push(promise);
      }
    }
    await Promise.allSettled(terminationPromises);
    this._activeContractControllers.clear();
    this.contractCompletedCallbacks.clear();
    // audit emit close event (additive const)
    this.audit?.write(CONTRACT_AUDIT_EVENTS.CONTRACT_SYSTEM_CLOSED, `clawId=${this.clawId}`);
  }
}
