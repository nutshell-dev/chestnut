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
 * - lifecycle.ts    / cancel/markCorrupted/isComplete/moveToArchive
 * - verification.ts / completeSubtask + verification pipeline
 *
 * 本 class own:
 * - 装配（ctx 构造）
 * - public API method（thin delegate）
 * - private contractDir helper（路径解析跨 active/archive；paused 仅 legacy detector）
 * - getProgress（读 progress.json）
 * - create（contract 创建）
 * - setOnNotify + onContractCompleted + _emitContractCompleted（事件）
 */

import * as yaml from 'js-yaml';
import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { newShortUuid } from '../../foundation/node-utils/index.js';

import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { Contract, SubtaskStatus } from '../contract/types.js';
import { ToolError } from '../../foundation/tools/errors.js';
import { type AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';


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
  emitContractCreatePolicyRejected,
  emitContractVerifierRegistered,
  emitContractVerifierUnregistered,
  emitContractLegacyPausedObserved,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { isolateCorruptedFile } from './_isolation-helper.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_PAUSED_DIR, CONTRACT_ARCHIVE_DIR, PROGRESS_FILE } from './dirs.js';
import { resolveContractLocation } from './locations.js';
import { type ClawId } from '../../foundation/claw-identity/index.js';

import type {
  ContractYaml, ProgressData, VerificationResult, VerifierConfig, VerifierResult,
  ContractCreatePolicy, CreatePolicyContext, CreateContractOptions,
} from './types.js';
import { ContractCreatePolicyViolationError, deriveProgressStatus, stripDerivableStatus, DERIVABLE_STATUSES, LIFECYCLE_PERSISTED_STATUSES, ARCHIVE_STATES } from './types.js';
import type { LifecyclePersistedStatus } from './types.js';
import {
  lockContract,
  acquireLock,
  releaseLock,
  type LockContext,
} from './lock.js';
import { loadActiveContract, type DiscoveryContext } from './discovery.js';
import {
  loadContractYaml as loadYaml, readContractYamlRaw as readYaml,
  loadContract as loadCt, saveProgress as saveProg,
  checkAllSubtasksCompleted,
  type PersistenceContext,
  PROGRESS_CURRENT_SCHEMA_VERSION,
} from './persistence.js';
import { ContractProgressPersistedSchema, ContractProgressArchiveLooseSchema } from './schemas.js';
import { type ContractId, makeContractId } from './types.js';
import { isAlive as defaultL1IsAlive } from '../../foundation/process-exec/index.js';
import { ContractValidationError } from './errors.js';
import { type SubtaskId, type ArchiveDir, type ArchiveState, makeArchiveDir } from './types.js';
import { runContractVerifier as defaultRunContractVerifier } from './verifier-job.js';
import {
  cancelContract, markCorrupted,
  isContractComplete, moveContractToArchive,
  type LifecycleContext,
} from './lifecycle.js';
import type { NotifyClawFn } from './verification-types.js';
import type { ContractCorruptionEvidence } from './types.js';
import {
  runVerificationPipeline,
  runScriptVerification as runScriptVerificationFn,
  runLLMVerification as runLLMVerificationFn,
  writeVerificationError,
  type VerificationContext,
} from './verification.js';
import { archiveAndEmit } from './verification-lifecycle.js';
import { reconcileArchiveStaleEntries } from './jobs/archive-reconciler.js';
import { VerificationMutex } from './verification-mutex.js';
import { ContractAuditor } from './contract-auditor.js';

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
  /** phase 104: caller (装配期) pre-bound notifyClaw (bind fs + chestnutRoot + audit) */
  notifyClaw: NotifyClawFn;
  fs: FileSystem;
  audit: AuditLog;
  llm?: LLMOrchestrator;
  toolRegistry: ToolRegistry;
  toolTimeoutMs?: number;
  fsFactory: (baseDir: string) => FileSystem;
  runContractVerifier?: typeof defaultRunContractVerifier;
  runSubagent?: VerifierConfig['runSubagent'];
  /** phase 1028: injectable lock retry budget — defaults to LOCK_MAX_RETRIES */
  lockMaxRetries?: number;
  /** phase 1028: injectable lock retry delay (ms) — defaults to LOCK_RETRY_DELAY_MS */
  lockRetryDelayMs?: number;
  /** Injectable lock retry wait for deterministic contention tests. */
  lockRetrySleep?: (delayMs: number) => Promise<void>;
  /** phase 1048: injectable process liveness checker for lock protocol */
  l1IsAlive?: typeof defaultL1IsAlive;
}

export class ContractSystem {
  private fs: FileSystem;
  private clawDir: string;
  private readonly clawId: ClawId;
  private readonly audit: AuditLog;
  private llm?: LLMOrchestrator;
  private notifyClaw: NotifyClawFn;
  private toolRegistry: ToolRegistry;
  private toolTimeoutMs?: number;
  private fsFactory: (baseDir: string) => FileSystem;
  private runContractVerifier: typeof defaultRunContractVerifier;
  private runSubagent?: VerifierConfig['runSubagent'];
  private lockMaxRetries?: number;
  private lockRetryDelayMs?: number;
  private lockRetrySleep?: (delayMs: number) => Promise<void>;
  private l1IsAlive?: typeof defaultL1IsAlive;

  private activeDir = CONTRACT_ACTIVE_DIR;
  private pausedDir = CONTRACT_PAUSED_DIR;
  private archiveDir: ArchiveDir = makeArchiveDir(CONTRACT_ARCHIVE_DIR);
  onNotify?: (type: string, data: Record<string, unknown>) => void;

  // phase 1424: contract auditor 周期 LLM 对照 expectations 检查 + inbox 高优反馈
  private auditor?: ContractAuditor;
  /** 同 contract 内 last audited step（防同 step 重复触发） */
  private auditorState = new Map<string, number>();

  private contractCompletedCallbacks: Set<(contractId: ContractId) => Promise<void>> = new Set();

  /**
   * phase 1020 (r124 C fork): per-contract active verifier controllers
   * cancelContract 触发后 abort 所有 controller / 真 propagate verifier subagent abort
   * 反 phase 993 D.1 dead field
   */
  private _activeContractControllers = new Map<string, Set<{ controller: AbortController; promise: Promise<unknown> }>>();

  // phase 687 (audit T2.4): _closed 幂等 guard、与 Runtime._stopped / AsyncTaskSystem._shuttingDown / CronRunner._stopped 同模式
  // 防 close() 双调时 duplicate CONTRACT_SYSTEM_CLOSED audit emit
  private _closed = false;

  /**
   * phase 1465: per-ContractSystem instance verification mutex
   * 应然：mutex 资源归 ContractSystem 实例 (M#3 资源唯一归属)
   * 实然 (改前)：模块级 const activePipelines = new Set<string>() 跨 vitest worker pool leak
   *               + test 需 _resetVerificationMutexForTest global hook 防 leak
   *               + dev log phase 1388-1393 多次 flaky 报告同根 + Tier 1 flaky_test_zero_tolerance 直接违反
   * 改后：each ContractSystem instance own its own mutex / per-test 自然 fresh / 0 leak / 0 reset hook
   */
  private readonly verificationMutex = new VerificationMutex();

  // Phase 230: contract create policy plug-in registry
  private createPolicies = new Map<string, ContractCreatePolicy>();

  // phase 1123 Step D: deduplicate legacy paused audit events per ContractSystem instance
  private _legacyPausedObserved = new Set<string>();

  private _registerVerifierController(contractId: ContractId, ctrl: AbortController, promise: Promise<unknown>): void {
    // Phase 968: audit FIRST so tracking never commits if audit fails
    emitContractVerifierRegistered(this.audit, { contractId });
    let s = this._activeContractControllers.get(contractId);
    if (!s) {
      s = new Set();
      this._activeContractControllers.set(contractId, s);
    }
    s.add({ controller: ctrl, promise });
  }

  private _unregisterVerifierController(contractId: ContractId, ctrl: AbortController): void {
    // Phase 970: remove from tracking FIRST so audit failures never leave stale controllers.
    const s = this._activeContractControllers.get(contractId);
    if (!s) return;
    for (const entry of s) {
      if (entry.controller === ctrl) {
        s.delete(entry);
        break;
      }
    }
    if (s.size === 0) this._activeContractControllers.delete(contractId);
    // Audit is best-effort — failure must not prevent tracking cleanup.
    try {
      emitContractVerifierUnregistered(this.audit, { contractId });
    } catch {
      // silent: tracking is correct but leave a trace for audit subsystem diagnosis
      process.stderr.write(`[contract] unregister verifier audit failed for ${contractId}\n`);
    }
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
            abortVerifierFailed: formatErr(abortErr),
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
    this.notifyClaw = deps.notifyClaw;
    this.toolRegistry = deps.toolRegistry;
    this.toolTimeoutMs = deps.toolTimeoutMs;
    this.fsFactory = deps.fsFactory;
    this.runContractVerifier = deps.runContractVerifier ?? defaultRunContractVerifier;
    this.runSubagent = deps.runSubagent;
    this.lockMaxRetries = deps.lockMaxRetries;
    this.lockRetryDelayMs = deps.lockRetryDelayMs;
    this.lockRetrySleep = deps.lockRetrySleep;
    this.l1IsAlive = deps.l1IsAlive;
  }

  setOnNotify(cb: (type: string, data: Record<string, unknown>) => void): void {
    this.onNotify = cb;
  }

  // ============================================================================
  // phase 1424: contract auditor 接入
  // ============================================================================

  /** Assembly 装配期调、注入 ContractAuditor 实例 / 仅设置 / 不主动 fire */
  attachAuditor(auditor: ContractAuditor): void {
    this.auditor = auditor;
  }

  /**
   * Runtime.onStepComplete 钩子调 / 每 ReAct step 完成后触发
   *
   * 1. 无 auditor 注入 → 直返（不破坏既有调用）
   * 2. 无 active contract → 直返
   * 3. contract.audit_interval 缺省 / 0 → 直返
   * 4. currentStep - lastAuditedStep < interval → 直返
   * 5. 否则：mark lastAuditedStep、fire-and-forget auditor.maybeAudit
   *
   * 容错：auditor 抛错不传播、写 audit 即返
   * 不 await LLM call（fire-and-forget / 不阻塞 Runtime step 推进）
   */
  async maybeAuditStep(currentStep: number): Promise<void> {
    if (!this.auditor) return;
    let active: Contract | null;
    try {
      active = await this.loadActive();
    } catch (err) {
      // phase 160: emit audit（DP「不丢弃静默」、playbook §1）
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.AUDITOR_LOAD_ACTIVE_FAILED,
        `clawId=${this.clawId}`,
        `step=${currentStep}`,
        `error=${formatErr(err)}`,
      );
      return;
    }
    if (!active) return;

    const contractYaml = await this.loadContractYaml(makeContractId(active.id));
    if (!contractYaml) {
      return;  // 容错：loadContractYaml schema corruption 不影响 Runtime
    }

    const interval = contractYaml.audit_interval ?? 0;
    if (interval <= 0) return;

    const last = this.auditorState.get(active.id) ?? 0;
    if (currentStep - last < interval) return;

    const progress = await this.getProgress(makeContractId(active.id));
    if (!progress) {
      return;  // 容错：getProgress schema corruption 不 advance auditorState、下次 step 仍会重试
    }

    const done: string[] = [];
    const pending: string[] = [];
    let inProgress: string | null = null;
    for (const [subtaskId, info] of Object.entries(progress.subtasks)) {
      if (info.status === 'completed') done.push(subtaskId);
      else if (info.status === 'in_progress') inProgress = subtaskId;
      else pending.push(subtaskId);
    }

    // 同步 mark：在确定要 fire-and-forget 后移到此处、防 Runtime 再次进入 maybeAuditStep 重复触发；
    // 上移到 getProgress 之前会让 getProgress null 容错路径静默丢失一次 audit（phase 438 修）
    this.auditorState.set(active.id, currentStep);

    // fire-and-forget
    void this.auditor.maybeAudit({
      contractId: active.id,
      contractTitle: active.title,
      clawId: this.clawId,
      currentStep,
      auditInterval: interval,
      lastAuditedStep: last,
      expectations: contractYaml.expectations,
      contractStartedAt: progress.started_at,
      progress: { done, in_progress: inProgress, pending },
    }).catch(() => {
      // 容错：auditor 内部已 audit + 限流、外层不重复 audit
    });
  }

  // ============================================================================
  // contractDir helper
  // ============================================================================

  private async contractDir(contractId: ContractId): Promise<string> {
    // phase 1127 Step B: typed resolver covers active + three archive state dirs + legacy flat.
    const loc = await resolveContractLocation({
      fs: this.fs,
      activeDir: this.activeDir,
      archiveDir: this.archiveDir,
      contractId,
      audit: this.audit,
    });
    if (!loc) throw new ToolError(`Contract "${contractId}" not found`);
    return loc.containerDir;
  }

  // ============================================================================
  // ctx 装配 helper
  // ============================================================================

  private _lockCtx(): LockContext {
    return {
      fs: this.fs,
      audit: this.audit,
      lockMaxRetries: this.lockMaxRetries,
      lockRetryDelayMs: this.lockRetryDelayMs,
      lockRetrySleep: this.lockRetrySleep,
      l1IsAlive: this.l1IsAlive,
    };
  }

  private _persistenceCtx(): PersistenceContext {
    return {
      fs: this.fs,
      audit: this.audit,
      contractDir: (id) => this.contractDir(id),
      getProgress: (id) => this.getProgress(id),
      markCorrupted: (id, evidence) => this.markCorrupted(id, evidence),
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
      archiveDir: this.archiveDir,
      contractDir: (id) => this.contractDir(id),
      loadContract: (id) => this.loadContract(id),
      getProgress: (id) => this.getProgress(id),
      saveProgress: (id, p, knownDir) => this.saveProgress(id, p, knownDir),
      checkAllSubtasksCompleted: (id, p) => this.checkAllCompleted(id, p),
      abortContractVerifiers: (id, reason) => this._abortContractVerifiers(id, reason),
      // phase 438: lazy thunk、setOnNotify 后的回调能在 ctx 已分发场景下生效（review N3-C-H3 / R2-C-N18）
      onNotify: (type, data) => this.onNotify?.(type, data),
    };
  }

  private _verificationCtx(signal?: AbortSignal): VerificationContext {
    const self = this;
    return {
      ...this._lockCtx(),
      clawDir: this.clawDir,
      clawId: this.clawId,
      // phase 104: caller pre-bound、直接 forward
      notifyClaw: this.notifyClaw,
      llm: this.llm,
      contractDir: (id) => this.contractDir(id),
      loadContractYaml: (id) => this.loadContractYaml(id),
      getProgress: (id) => this.getProgress(id),
      saveProgress: (id, p, knownDir) => this.saveProgress(id, p, knownDir),
      checkAllSubtasksCompleted: (id, p) => this.checkAllCompleted(id, p),
      moveContractToArchive: (id, targetState) => this.moveToArchive(id, targetState),
      emitContractCompleted: (id) => this._emitContractCompleted(id),
      // phase 438: lazy thunk、同 _lifecycleCtx
      onNotify: (type, data) => this.onNotify?.(type, data),
      // Phase 965: propagate cancellation signal to verification execution
      signal,
      runScriptVerification: function(scriptFile: string, contractAbsDir: string) {
        return self.runScriptVerification(scriptFile, contractAbsDir, this.signal);
      },
      runLLMVerification: function(promptFile: string, contractAbsDir: string, contractId: ContractId, subtaskId: SubtaskId, subtaskDesc: string, evidence: string, artifacts: string[]) {
        return self.runLLMVerification(promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts, this.signal);
      },
      withProgressLock: (contractId, fn) => this.withProgressLock(contractId, fn),
      toolRegistry: this.toolRegistry,
      toolTimeoutMs: this.toolTimeoutMs,
      verificationMutex: this.verificationMutex,
      // Phase 965: register/unregister active verifier controllers for cancel/close
      registerController: (contractId, controller, promise) => {
        this._registerVerifierController(contractId, controller, promise);
      },
      unregisterController: (contractId, controller) => {
        this._unregisterVerifierController(contractId, controller);
      },
      runVerifierWithCancel: async function(contractId, config) {
        // Phase 967: always create and register our own AbortController so the
        // verifier is visible to cancel/close even when an outer signal exists.
        const controller = new AbortController();
        const signal = this.signal;
        const effectiveSignal = signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal;
        const promise = self.runContractVerifier({ ...config, signal: effectiveSignal, contractId, fsFactory: self.fsFactory, runSubagent: self.runSubagent });
        self._registerVerifierController(contractId, controller, promise);
        try {
          return await promise;
        } finally {
          self._unregisterVerifierController(contractId, controller);
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

  /**
   * phase 1123 Step D: read-only legacy paused detector.
   * Scans contract/paused/ and returns tagged references without moving data.
   * Emits a deduplicated audit event per legacy contract per instance.
   */
  async findLegacyPausedContracts(): Promise<Array<{ contractId: ContractId; sourcePath: string }>> {
    const results: Array<{ contractId: ContractId; sourcePath: string }> = [];
    if (!(await this.fs.exists(this.pausedDir))) return results;
    const entries = await this.fs.list(this.pausedDir, { includeDirs: true });
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const progressPath = `${this.pausedDir}/${entry.name}/progress.json`;
      if (!(await this.fs.exists(progressPath))) continue;
      const contractId = makeContractId(entry.name);
      const sourcePath = `${this.pausedDir}/${entry.name}`;
      results.push({ contractId, sourcePath });
      if (!this._legacyPausedObserved.has(entry.name)) {
        this._legacyPausedObserved.add(entry.name);
        emitContractLegacyPausedObserved(this.audit, {
          clawId: this.clawId,
          contractId,
          sourcePath,
        });
      }
    }
    return results;
  }

  /**
   * boot reconcile / DP「中断恢复 + 持久化一切 + 事后可审计」直接 derive
   * phase 1285 InboxReader.init() 模板 mirror
   */
  async init(): Promise<void> {
    // phase 1123 Step C: current semantics no longer include paused.
    this.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
      'recovered=false',
    );

    // phase 1371 sub-2: boot reconcile — scan active contracts for archive_pending_recovery
    let failedCount = 0;
    if (await this.fs.exists(this.activeDir)) {
      const entries = await this.fs.list(this.activeDir, { includeDirs: true });
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const progressPath = `${this.activeDir}/${entry.name}/progress.json`;
        if (!(await this.fs.exists(progressPath))) continue;
        try {
          const raw = await this.fs.read(progressPath);
          // phase 335 Zod SoT (ML#9 优先编译器检查、phase 332 升档 (A) sister):
          // boot_reconcile = legacy migration loop business semantic、复用 ContractProgressArchiveLooseSchema loose schema (passthrough subtasks 允许 legacy 'escalated' status)
          const rawParsed: unknown = JSON.parse(raw);
          const validation = ContractProgressArchiveLooseSchema.safeParse(rawParsed);
          if (!validation.success) {
            this.audit.write(
              CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_SCHEMA_FAILED,
              `contract=${entry.name}`,
              'reason=schema_parse_failed',
            );
            failedCount++;
            continue;
          }
          const progress = validation.data;

          // NEW phase 1399: active dir 'escalated' 残留 migrate → completed + force_accepted
          if (progress.subtasks) {
            let mutated = false;
            for (const [stId, st] of Object.entries(progress.subtasks)) {
              if (st.status === 'escalated') {
                st.status = 'completed';
                st.force_accepted = true;
                delete st.escalated_at;
                if (!st.completed_at) st.completed_at = new Date().toISOString();
                mutated = true;
                this.audit.write(
                  CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_MIGRATE_ESCALATED,
                  `contractId=${progress.contract_id ?? entry.name}`,
                  `subtaskId=${stId}`,
                );
              }
            }
            if (mutated) {
              // phase 319: 删 assertProgressShapeInvariants（load 端 ContractProgressPersistedSchema.safeParse 已守、boot reconcile 双 check 冗余）
              // phase 338: align phase 282 Step A design intent (derivable status 不持久化、由 loader derive from subtasks)、strip derivable before writeAtomic
              // phase 342: stripDerivableStatus helper (ML#1 共用基础设施单源、与 persistence.ts saveProgress 共用)
              const persistedProgress: Record<string, unknown> = { ...progress };
              stripDerivableStatus(persistedProgress);
              await this.fs.writeAtomic(progressPath, JSON.stringify(persistedProgress, null, 2));
              const allCompleted = Object.values(progress.subtasks).every(s => s.status === 'completed');
              if (allCompleted && progress.status !== 'completed') {
                // phase 338: status mutation in-memory only (downstream archiveAndEmit 用)、2nd writeAtomic 删 (redundant after strip)
                progress.status = 'completed';
                progress.completed_at = new Date().toISOString();
                const contractId = makeContractId(progress.contract_id ?? entry.name);
                // phase 1405: yaml load 失败时跳过 archive、显式 audit 留 forensics（避免 stuck-in-active 静默）
                let contractYaml: Awaited<ReturnType<typeof this.loadContractYaml>> | null = null;
                try {
                  contractYaml = await this.loadContractYaml(contractId);
                } catch (err) {
                  this.audit.write(
                    CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_MIGRATE_ARCHIVE_SKIPPED,
                    `contractId=${contractId}`,
                    `reason=yaml_load_failed`,
                    `error=${formatErr(err)}`,
                  );
                }
                if (contractYaml) {
                  await archiveAndEmit(this._verificationCtx(), contractId, contractYaml, 'init.migrate_escalated');
                }
              }
            }
          }

          if (progress.status === 'archive_pending_recovery') {
            const contractId = makeContractId(progress.contract_id ?? entry.name);
            // phase 1127 Step D: recovery must first transition status to completed
            // so the typed writer can move it into archive/completed/.
            progress.status = 'completed';
            progress.completed_at = new Date().toISOString();
            const persistedProgress: Record<string, unknown> = { ...progress };
            stripDerivableStatus(persistedProgress);
            await this.fs.writeAtomic(progressPath, JSON.stringify(persistedProgress, null, 2));
            const contractYaml = await this.loadContractYaml(contractId);
            if (contractYaml) {
              await archiveAndEmit(
                this._verificationCtx(),
                contractId,
                contractYaml,
                'ContractSystem.init.bootReconcile',
              );
            }
          }
        } catch (err) {
          this.audit.write(
            CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE_SKIPPED,
            `path=${progressPath}`,
            `error=${formatErr(err)}`,
          );
          // silent: corrupted progress.json boot reconcile best-effort skip（forensics emit 上面）
        }
      }
    }

    if (failedCount > 0) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
        `schema_failed_count=${failedCount}`,
      );
    }

    // NEW phase 966: boot reconcile — reset leftover in_progress subtasks so submit can retry.
    // Phase 968: per-contract try/catch isolation so one corrupt contract doesn't block others.
    try {
      if (await this.fs.exists(this.activeDir)) {
        const activeEntries = await this.fs.list(this.activeDir, { includeDirs: true });
        for (const entry of activeEntries) {
          try {
            if (!entry.isDirectory) continue;
            const contractId = makeContractId(entry.name);
            const progress = await this.getProgress(contractId);
            if (!progress || progress.status !== 'running') continue;
            let mutated = false;
            const resetIds: string[] = [];
            for (const [stId, subtask] of Object.entries(progress.subtasks)) {
              if (subtask.status === 'in_progress') {
                subtask.status = 'todo';
                delete subtask.verification_attempt_id;
                resetIds.push(stId);
                mutated = true;
              }
            }
            if (mutated) {
              // Phase 970: save progress FIRST so audit failures cannot block the reset.
              await this.saveProgress(contractId, progress);
              for (const stId of resetIds) {
                try {
                  this.audit.write(
                    CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET,
                    `contract=${entry.name}`,
                    `subtask=${stId}`,
                  );
                } catch {
                  // best-effort audit: leave stderr trace for diagnosis
                  process.stderr.write(`[contract] boot reconcile in_progress reset audit failed for ${entry.name}/${stId}\n`);
                }
              }
            }
          } catch (err) {
            this.audit.write(
              CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET_FAILED,
              `contract=${entry.name}`,
              `reason=${formatErr(err)}`,
            );
          }
        }
      }
    } catch (err) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_TERMINAL_MOVE_FAILED,
        `context=in_progress_reset`,
        `reason=${formatErr(err)}`,
      );
    }

    // phase 954 / 1123 Step C: boot reconcile — recover terminal contracts stuck in active/.
    // phase 1127 Step D: route to the canonical state subdirectory; crashed has no
    // current archive state directory and is left in active/ for explicit handling.
    const BOOT_RECONCILE_TERMINAL_STATUSES = new Set(['cancelled', 'completed']);
    try {
      if (await this.fs.exists(this.activeDir)) {
        const activeEntries = await this.fs.list(this.activeDir, { includeDirs: true });
        for (const entry of activeEntries) {
          if (!entry.isDirectory) continue;
          const progressPath = `${this.activeDir}/${entry.name}/progress.json`;
          if (!(await this.fs.exists(progressPath))) continue;
          try {
            const raw = await this.fs.read(progressPath);
            const rawParsed: unknown = JSON.parse(raw);
            const validation = ContractProgressArchiveLooseSchema.safeParse(rawParsed);
            if (!validation.success) continue;
            const progress = validation.data;
            const status = progress.status ?? '';

            if (!BOOT_RECONCILE_TERMINAL_STATUSES.has(status)) continue;

            const contractId = makeContractId(progress.contract_id ?? entry.name);
            if (status === 'completed') {
              const contractYaml = await this.loadContractYaml(contractId);
              if (!contractYaml) continue;
              await archiveAndEmit(
                this._verificationCtx(),
                contractId,
                contractYaml,
                'ContractSystem.init.bootReconcile.terminal',
              );
            } else if (status === 'cancelled') {
              await this.cancel(contractId, 'boot reconcile');
            }
            this.audit.write(
              CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_TERMINAL_MOVED,
              `contract_id=${contractId}`,
              `status=${status}`,
            );
          } catch (err) {
            this.audit.write(
              CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_TERMINAL_MOVE_FAILED,
              `contract_id=${entry.name}`,
              `reason=${formatErr(err)}`,
            );
          }
        }
      }
    } catch (err) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_TERMINAL_MOVE_FAILED,
        `context=lifecycle_recovery_outer`,
        `reason=${formatErr(err)}`,
      );
    }

    // NEW phase 188 Step C: archive 目录 stale active 态 sweep
    try {
      await reconcileArchiveStaleEntries(
        { fs: this.fs, audit: this.audit },
        this.clawId,
        this.clawDir,
      );
      // summary 已由 reconcileArchiveStaleEntries 内 emit
      // 此处不再额外 audit、不阻断 init 后续路径
    } catch (err) {
      // reconciler 内已 catch + audit emit；此处兜底（理论 unreachable）
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_FAILED,
        `clawId=${this.clawId}`,
        `context=init_outer_catch`,
        `error=${formatErr(err)}`,
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
  async cancel(contractId: ContractId, reason: string): Promise<void> {
    await cancelContract(this._lifecycleCtx(), contractId, reason);
    // phase 398 Step D (review N9): 终态清 auditorState、防 unbounded growth +
    // contract-id 复用残留。cancel 失败 throw、entry 留待重试。
    this.auditorState.delete(contractId);
  }

  async markCorrupted(
    contractId: ContractId,
    evidence: ContractCorruptionEvidence,
    knownDir?: string,
  ): Promise<void> {
    await markCorrupted(this._lifecycleCtx(), contractId, evidence, knownDir);
    // phase 398 Step D (review N9): 同 cancel。
    this.auditorState.delete(contractId);
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
            error: formatErr(e),
          },
        );
      }
    }
    // phase 398 Step D (review N9): 完成态清 auditorState、防 unbounded growth +
    // contract-id 复用残留（callback 失败已 audit、不阻 delete）。
    this.auditorState.delete(contractId);
  }

  // ============================================================================
  // class own logic（不下沉的部分）
  // ============================================================================

  registerCreatePolicy(name: string, policy: ContractCreatePolicy): void {
    // by-design: 后注册覆盖（caller 模块装配期通常只注册一次、Assembly 集中 wire）
    this.createPolicies.set(name, policy);
  }

  async create(contractYaml: ContractYaml): Promise<string>;
  async create(options: CreateContractOptions): Promise<string>;
  async create(arg: ContractYaml | CreateContractOptions): Promise<string> {
    const opts = 'contract' in arg ? arg : { contract: arg };
    const contractYaml = opts.contract;
    // Phase 230: policy iteration（在 schema 校验后、lock 创建前）
    const ctx: CreatePolicyContext = {
      subagentTaskId: opts.subagentTaskId,
      clawDir: opts.clawDir,
    };
    for (const policy of this.createPolicies.values()) {
      try {
        await policy.check(ctx, contractYaml);
      } catch (err) {
        if (err instanceof ContractCreatePolicyViolationError) {
          emitContractCreatePolicyRejected(this.audit, {
            policyName: err.policyName,
            cause: err.cause,
            details: err.details,
          });
        }
        throw err; // 上抛、契约不创建
      }
    }

    // Phase 957: claw-level create lock — 串并「校验 → 查重 → 读 active → 归档旧 → 建新」全路径。
    const clawLockPath = '.contract-create.lock';
    const createLockOwnerToken = await acquireLock(this._lockCtx(), clawLockPath);
    try {
      if (contractYaml.id !== undefined && contractYaml.id.trim() === '') {
        throw new ContractValidationError('id', 'empty',
          'contract id must not be empty (yaml: id: "<not blank>")');
      }
      const contractId = makeContractId(contractYaml.id || `${Date.now()}-${newShortUuid()}`);

      // Phase 956: check uniqueness across current directories (active + archive states + legacy flat)
      // phase 1123 Step C: paused/ is legacy-only and must not block creation.
      // phase 1127 Step B: creation must not collide with any current archive state container or legacy flat entry.
      const archiveStateDirs = [...ARCHIVE_STATES].map(state => `${this.archiveDir}/${state}`);
      for (const dir of [this.activeDir, ...archiveStateDirs, this.archiveDir]) {
        if (await this.fs.exists(`${dir}/${contractId}`)) {
          throw new ContractValidationError('id', 'already_exists',
            `contract id "${contractId}" already exists in ${path.basename(dir)}`,
            { contractId });
        }
      }

      if (!contractYaml.subtasks || contractYaml.subtasks.length === 0) {
        throw new ContractValidationError('subtasks', 'missing',
          'contract must have at least one subtask (yaml: subtasks: [- id: ..., description: ...])');
      }

      // phase 366 L4 (review-2026-06-13): schema 已 require script_file / prompt_file
      // per type、生产 yaml parse 路径已 enforce。本 runtime check 保留作 defense in depth
      // —— 直接 caller（测试 / 未来 SDK）若绕过 parse 传 raw object 也能在 manager.create
      // 入口被拒。TS narrow 使分支编译期看是 never，用 as Record 绕回 runtime 真验。
      for (const a of contractYaml.verification ?? []) {
        const aRaw = a as unknown as Record<string, unknown>;
        if (a.type === 'script' && typeof aRaw.script_file !== 'string') {
          throw new ContractValidationError('verification', 'config_missing_field',
            `verification config for subtask "${a.subtask_id}" has type='script' but missing 'script_file' (yaml: verification: [- subtask_id: "${a.subtask_id}", type: script, script_file: ./path.sh])`,
            { subtaskId: a.subtask_id, configType: 'script', missingField: 'script_file' });
        }
        if (a.type === 'llm' && typeof aRaw.prompt_file !== 'string') {
          throw new ContractValidationError('verification', 'config_missing_field',
            `verification config for subtask "${a.subtask_id}" has type='llm' but missing 'prompt_file' (yaml: verification: [- subtask_id: "${a.subtask_id}", type: llm, prompt_file: ./prompt.md])`,
            { subtaskId: a.subtask_id, configType: 'llm', missingField: 'prompt_file' });
        }
      }

      const seenSubtaskIds = new Set<string>();
      for (const a of contractYaml.verification ?? []) {
        if (seenSubtaskIds.has(a.subtask_id)) {
          throw new ContractValidationError('verification', 'duplicate',
            `verification config: duplicate subtask_id "${a.subtask_id}" — each subtask can only have one verification entry (remove duplicate row in yaml)`,
            { subtaskId: a.subtask_id });
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
          // phase 188 Step A: archive precondition requires terminal status
          // phase 282 Step A: status derive from subtasks → flip old contract subtasks
          // to completed before archiving (create replaces old contract)
          // phase 324 H6: 标 force_accepted + last_failed_feedback + audit 一条
          // SUBTASK_FORCE_COMPLETED_REPLACED，让下游（evolution / retro）能区分
          // 被替换的 abandoned subtask 与真实完成的 subtask。
          const existingId = makeContractId(existing.id);
          await this.withProgressLock(existingId, async () => {
            const progress = await this.getProgress(existingId);
            if (progress && !['completed', 'cancelled', 'crashed', 'archive_pending_recovery'].includes(progress.status)) {
              for (const [subtaskId, st] of Object.entries(progress.subtasks)) {
                if (st.status !== 'completed') {
                  st.status = 'completed';
                  st.force_accepted = true;   // phase 324 H6: 区分 abandoned vs 真完成
                  // 不设 last_failed_feedback：本路径无 verification failure；
                  // 替换原因走 SUBTASK_FORCE_COMPLETED_REPLACED audit、是 SoT。
                  if (!st.completed_at) st.completed_at = new Date().toISOString();
                  this.audit.write(
                    CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_COMPLETED_REPLACED,
                    `contractId=${existingId}`,
                    `subtaskId=${subtaskId}`,
                    `new_contract_id=${contractId}`,
                    `reason=replaced_by_new_contract`,
                  );
                }
              }
              await this.saveProgress(existingId, progress);
            }
          });
          await this.moveToArchive(existingId);
        } catch (err) {
          emitContractMoveArchiveFailed(
            this.audit,
            {
              old: existing.id,
              new: contractId,
              reason: formatErr(err),
            },
          );
          // phase 1038 α-7: throw instead of swallow — state machine invariant「1 active contract per claw」
          // 不可 create new contract while previous archive failed (导致 multi-active state)
          throw new ToolError(
            `Cannot create contract "${contractId}": previous active contract "${existing.id}" archive failed. ` +
            `Manual intervention required: check archive/ dir + retry create. Original error: ${formatErr(err)}`,
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
        verification_attempts: contractYaml.verification_attempts,
        audit_interval: contractYaml.audit_interval,
        auth_level: contractYaml.auth_level ?? CONTRACT_DEFAULTS.auth_level,
      });
      await this.fs.writeAtomic(`${this.activeDir}/${contractId}/contract.yaml`, content);

      const progress: ProgressData = {
        schema_version: PROGRESS_CURRENT_SCHEMA_VERSION,
        contract_id: contractId,
        status: 'running',
        subtasks: Object.fromEntries(
          contractYaml.subtasks.map((st: { id: string }) => [st.id, { status: 'todo' as SubtaskStatus }])
        ),
        started_at: new Date().toISOString(),
        checkpoint: null,
      };
      try {
        // phase 282 Step B: persist without derive fields (contract_id/status)
        const persisted = { ...progress };
        delete (persisted as Record<string, unknown>).contract_id;
        delete (persisted as Record<string, unknown>).status;
        await this.fs.writeAtomic(
          `${this.activeDir}/${contractId}/progress.json`,
          JSON.stringify(persisted, null, 2)
        );
      } catch (err) {
        await this.fs.removeDir(`${this.activeDir}/${contractId}`).catch((deleteErr) => {
          if ([TypeError, ReferenceError, SyntaxError, RangeError].some(T => deleteErr instanceof T)) {
            emitContractUnexpectedAsyncThrow(
              this.audit,
              {
                context: 'ContractSystem.rollbackCleanup',
                contractId,
                errorType: deleteErr instanceof Error ? deleteErr.constructor.name : typeof deleteErr,
                error: formatErr(deleteErr),
                stack: deleteErr instanceof Error ? deleteErr.stack ?? '' : '',
              },
            );
          }
          emitContractRollbackFailed(
            this.audit,
            {
              contractId,
              error: formatErr(deleteErr),
            },
          );
        });
        // verify rollback succeeded
        if (await this.fs.exists(`${this.activeDir}/${contractId}`)) {
          // phase 337 M3 (review-2026-06-13): 写 .rollback-incomplete sentinel
          // 到 dir 内、让 ops + 未来 boot reconcile 一眼可见这是 stale 失败 rollback、
          // 不是合法 active contract。dir 仍在但已 marked。audit 单独 emit。
          const sentinelPath = `${this.activeDir}/${contractId}/.rollback-incomplete`;
          const sentinelBody = JSON.stringify({
            contract_id: contractId,
            failed_at: new Date().toISOString(),
            original_error: formatErr(err),
            message: 'Contract.create rollback failed — dir is stale; ops should remove manually',
          }, null, 2);
          await this.fs.writeAtomic(sentinelPath, sentinelBody).catch((sentinelErr) => {
            emitContractRollbackFailed(
              this.audit,
              {
                contractId,
                error: `sentinel write failed: ${formatErr(sentinelErr)}`,
              },
            );
          });
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
          { error: formatErr(err) },
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
    } finally {
      await releaseLock(this._lockCtx(), clawLockPath, createLockOwnerToken);
    }
  }

  /**
   * 读 contract progress.json。
   *
   * TOCTOU mitigation: `contractDir` + `fs.read` 跨步骤间、archive move
   * (verification-lifecycle.ts:34 `moveContractToArchive` 在 withProgressLock
   * 外执行) 可能将文件从 active dir 移到 archive dir。捕 `FileNotFoundError`
   * 重探 contractDir 一次。第二次仍 FileNotFoundError 则真不存在、暴露给 caller。
   */
  async getProgress(contractId: ContractId): Promise<ProgressData | null> {
    let dir: string;
    let content: string;
    try {
      dir = await this.contractDir(contractId);
      content = await this.fs.read(`${dir}/${contractId}/progress.json`);
    } catch (err) {
      if (!isFileNotFound(err)) throw err;
      // race retry: contractDir + fs.read 再走一遍，archive 已稳定
      dir = await this.contractDir(contractId);
      content = await this.fs.read(`${dir}/${contractId}/progress.json`);
    }
    const progressPath = `${dir}/${contractId}/progress.json`;
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(content);
    } catch (parseErr) {
      // phase 958: JSON.parse SyntaxError → same isolation path as schema validation failure
      if (parseErr instanceof SyntaxError) {
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
          `contractId=${contractId}`,
          `reason=json_parse_failed`,
          `error=${formatErr(parseErr)}`,
        );
        const isolated = await isolateCorruptedFile(this.fs, this.audit, {
          contractId, contractDir: `${dir}/${contractId}`, filename: PROGRESS_FILE,
          reason: 'json_parse_error',
        });
        if (!isolated) {
          this.audit.write(
            CONTRACT_AUDIT_EVENTS.CONTRACT_FILE_ISOLATION_FAILED,
            `contractId=${contractId}`,
            `context=isolation_failed_cannot_proceed`,
            `reason=isolation_move_failed`,
          );
          throw new Error(`Cannot isolate corrupt progress.json for ${contractId} — aborting to avoid recursive getProgress`);
        }
        await this.markCorrupted(contractId, {
          reason: 'progress_json_parse_error',
          relativePath: isolated.relativePath,
        }, dir);
        return null;
      }
      throw parseErr;
    }

    // phase 319: legacy derive field handling (contract_id + status) before strict Zod parse
    // (Zod .strict() would reject these legacy fields、需先 strip + emit audit observability for derive)
    const legacyContractId = (rawParsed as Record<string, unknown>).contract_id;
    if (legacyContractId !== undefined) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_CONTRACT_ID_FIELD_IGNORED,
        `contractId=${contractId}`,
        `legacy_contract_id=${String(legacyContractId)}`,
      );
      delete (rawParsed as Record<string, unknown>).contract_id;
    }
    const legacyStatus = (rawParsed as Record<string, unknown>).status;
    // phase 345: narrow type LifecyclePersistedStatus (disjoint subset、derive subset 由 derivedStatus 处理)
    let preservedLifecycleStatus: LifecyclePersistedStatus | undefined;
    // phase 365: explicit LIFECYCLE_PERSISTED_STATUSES membership check (replace unsafe cast)
    // ML#9 + DP「不静默」: unknown legacy string (非 derive 非 persist) 显式 emit audit + 忽略、不 fake-cast as LifecyclePersistedStatus
    if (typeof legacyStatus === 'string') {
      if ((LIFECYCLE_PERSISTED_STATUSES as ReadonlySet<string>).has(legacyStatus)) {
        // 保留不可 derive 的生命周期状态（cancelled/crashed/archive_pending_recovery）
        preservedLifecycleStatus = legacyStatus as LifecyclePersistedStatus;
      } else if (!(DERIVABLE_STATUSES as ReadonlySet<string>).has(legacyStatus)) {
        // unknown legacy string (非 derive 非 persist)、emit audit + 忽略
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_STATUS_FIELD_IGNORED,
          `contractId=${contractId}`,
          `legacy_status=${String(legacyStatus)}`,
          `reason=unknown_lifecycle`,
        );
      } else {
        // 可 derive 状态、legacy field 忽略 + emit audit
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_STATUS_FIELD_IGNORED,
          `contractId=${contractId}`,
          `legacy_status=${String(legacyStatus)}`,
        );
      }
    }
    delete (rawParsed as Record<string, unknown>).status;

    // phase 319: Zod SoT safeParse (mirror phase 311 ContractYamlSchema pattern)
    const result = ContractProgressPersistedSchema.safeParse(rawParsed);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const isSchemaVersionIssue = firstIssue?.path[0] === 'schema_version';
      if (isSchemaVersionIssue) {
        emitContractProgressSchemaInvalid(
          this.audit,
          {
            contractId,
            path: progressPath,
            reason: 'unknown_schema_version',
            actual: String((rawParsed as Record<string, unknown>).schema_version),
            current: PROGRESS_CURRENT_SCHEMA_VERSION,
          },
        );
      } else {
        emitContractProgressSchemaInvalid(
          this.audit,
          {
            contractId,
            path: progressPath,
            raw: this.audit.preview(content),
          },
        );
      }
      const isolationReason = isSchemaVersionIssue ? 'unknown_schema_version' : 'schema_invalid';
      // phase 958: isolate corrupted progress.json first, then markCorrupted with known dir.
      // markCorrupted internally re-resolves contractDir via progress.json existence;
      // after isolation progress.json is gone, so pass the known dir to avoid orphan.
      const isolated = await isolateCorruptedFile(this.fs, this.audit, {
        contractId, contractDir: `${dir}/${contractId}`, filename: PROGRESS_FILE,
        reason: isolationReason,
      });
      if (!isolated) {
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_FILE_ISOLATION_FAILED,
          `contractId=${contractId}`,
          `context=isolation_failed_cannot_proceed`,
          `reason=isolation_move_failed`,
        );
        throw new Error(`Cannot isolate corrupt progress.json for ${contractId} — aborting to avoid recursive getProgress`);
      }
      const corruptionReason: ContractCorruptionEvidence['reason'] = isSchemaVersionIssue
        ? 'progress_unknown_schema_version'
        : 'progress_schema_invalid';
      await this.markCorrupted(contractId, {
        reason: corruptionReason,
        relativePath: isolated.relativePath,
      }, dir);
      return null;
    }

    // phase 282 Step A/B: derive status + contract_id from caller/dir/subtasks
    const derivedStatus = preservedLifecycleStatus ?? deriveProgressStatus({ subtasks: result.data.subtasks });
    return {
      ...result.data,
      contract_id: contractId,
      status: derivedStatus,
    };
  }

  // ============================================================================
  // private thin delegate（保 method 名 / tests white-box 调用面 + spy 保护）
  // ============================================================================

  private async withProgressLock<T>(contractId: ContractId, fn: () => Promise<T>): Promise<T> {
    const { release } = await lockContract(this._lockCtx(), contractId, (id) => this.contractDir(id));
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async loadContractYaml(contractId: ContractId): Promise<ContractYaml | null> {
    return loadYaml(this._persistenceCtx(), contractId);
  }

  async _writeVerificationError(contractId: ContractId, subtaskId: SubtaskId, error: unknown): Promise<{ archived?: boolean }> {
    return writeVerificationError(this._verificationCtx(), contractId, subtaskId, error);
  }

  private async loadContract(contractId: ContractId): Promise<Contract> {
    return loadCt(this._persistenceCtx(), contractId);
  }

  private async saveProgress(contractId: ContractId, progress: ProgressData, knownDir?: string): Promise<void> {
    return saveProg(this._persistenceCtx(), contractId, progress, knownDir);
  }

  private async checkAllCompleted(contractId: ContractId, progress: ProgressData): Promise<boolean> {
    return checkAllSubtasksCompleted(this._persistenceCtx(), contractId, progress);
  }

  private async moveToArchive(contractId: ContractId, targetState: ArchiveState = 'completed'): Promise<void> {
    return moveContractToArchive(this._lifecycleCtx(), contractId, targetState);
  }

  private async runScriptVerification(scriptFile: string, contractAbsDir: string, signal?: AbortSignal): Promise<VerificationResult> {
    return runScriptVerificationFn(this._verificationCtx(signal), scriptFile, contractAbsDir);
  }

  private async runLLMVerification(
    promptFile: string,
    contractAbsDir: string,
    contractId: ContractId,
    subtaskId: SubtaskId,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
    signal?: AbortSignal,
  ): Promise<VerificationResult> {
    return runLLMVerificationFn(this._verificationCtx(signal), promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts);
  }

  /**
   * phase 1217 (r131 C fork): true disposable / abort all active verifier controllers
   * phase 1335 (r138 F fork): async close / await verifier termination promises
   */
  async close(): Promise<void> {
    // phase 687 (audit T2.4): 幂等 guard、防双调 duplicate CONTRACT_SYSTEM_CLOSED audit emit
    if (this._closed) return;
    this._closed = true;
    // phase 517 B3: auditor 先 close（防 dispose 期间 fire-and-forget maybeAudit 又产生新 LLM call）
    if (this.auditor) {
      try {
        await this.auditor.close();
      } catch {
        // silent: auditor close 失败不阻其他 dispose / best-effort cleanup
      }
    }

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
