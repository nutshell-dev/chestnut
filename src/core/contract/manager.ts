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
 * - lifecycle.ts    / cancel/markCorrupted/isComplete/commitTerminalLifecycle
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

import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { newShortUuid, sha256Hex } from '../../foundation/node-utils/index.js';

import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { Contract } from '../contract/types.js';
import { ToolError } from '../../foundation/tools/index.js';
import { type AuditLog } from '../../foundation/audit/index.js';
import type { Tool, ToolRegistry } from '../../foundation/tools/index.js';


import {
  emitContractCompletedHandlerFailed,
  emitContractNotifyFailed,
  emitContractCreated,
  emitContractProgressSchemaInvalid,
  emitContractCreatePolicyRejected,
  emitContractVerifierRegistered,
  emitContractVerifierUnregistered,
  emitContractLegacyPausedObserved,
  emitContractCreationClaimed,
  emitContractCreationInterrupted,
  emitVerificationOutcomeReplay,
  emitVerifierAbortFailed,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { isolateCorruptedFile } from './_isolation-helper.js';
import { classifyCorruption, classifySchemaViolation, isolationReasonFor } from './corruption.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_PAUSED_DIR, CONTRACT_ARCHIVE_DIR, PROGRESS_FILE } from './dirs.js';
import { resolveContractLocation, resolveActiveContractLocation, listPhysicalActiveContractIds, type ActiveContractLocation } from './locations.js';
import { type ClawId } from '../../foundation/claw-identity/index.js';

import type {
  ContractYaml, ProgressData, VerificationResult, VerifierConfig, VerifierResult,
  ContractCreatePolicy, CreatePolicyContext, CreateContractOptions,
  ContractRuntimeLifecycle, ContractCloseOutcome,
} from './types.js';
import { ContractCreatePolicyViolationError, deriveProgressStatus, ARCHIVE_STATES } from './types.js';
import type { ContractNotification, ContractNotificationSink } from './notification.js';

import { loadActiveContract, type DiscoveryContext } from './discovery.js';
import {
  loadContractYaml as loadYaml, readContractYamlRaw as readYaml,
  loadContract as loadCt, saveActiveProgressExisting as saveActiveProg,
  checkAllSubtasksCompleted,
  type PersistenceContext,
  PROGRESS_CURRENT_SCHEMA_VERSION,
} from './persistence.js';
import { ContractProgressPersistedSchema, ContractProgressArchiveLooseSchema } from './schemas.js';
import { type ContractId, makeContractId } from './types.js';

import { ContractValidationError, ContractArchiveReadError, ContractLocationAmbiguityError } from './errors.js';
import { type SubtaskId, type ArchiveDir, makeArchiveDir } from './types.js';
import { runContractVerifier as defaultRunContractVerifier } from './verifier-job.js';
import {
  cancelContract, markCorrupted, failContract,
  isContractComplete,
  reconcilePendingLifecycleIntents,
  type LifecycleContext,
  type TerminalTransitionOutcome,
} from './lifecycle.js';
import type { NotifyClawFn, VerificationGatewayResult, SyncCompletionGatewayResult } from './verification-types.js';
import type { VerificationAttemptTransition } from './verification-transition-types.js';
import type { ContractCorruptionEvidence } from './types.js';
import type { ContractFailure, ContractExecutionFailure, ExecutionFailureReportOutcome } from './types.js';
import {
  runVerificationPipeline,
  runScriptVerification as runScriptVerificationFn,
  runLLMVerification as runLLMVerificationFn,
  writeVerificationError,
  type VerificationContext,
} from './verification.js';
import { buildSubmitSubtaskTool, type SubmitSubtaskParams } from './tools/submit-subtask.js';
import { archiveAndEmit } from './verification-lifecycle.js';
import { formatValidIds } from './verification-format.js';
import {
  isOutcomeAlreadyApplied,
  persistVerificationOutcome,
  readVerificationOutcomesForContract,
  type PersistVerificationOutcomeResult,
  type VerificationOutcomeIntent,
} from './verification-outcome.js';
import { reconcileArchiveStaleEntries } from './jobs/archive-reconciler.js';
import { migrateLegacyArchiveEntries } from './jobs/archive-legacy-migrator.js';

import { readArchivePayload } from './archive-reader.js';
import { ProgressMutationQueue, type ProgressMutationMeta } from './progress-mutation-queue.js';
import { ContractAuditor } from './contract-auditor.js';
import {
  CREATION_CLAIM_FILE,
  buildCreationIntent,
  findArchiveCollisionLocation,
  isAlreadyExists,
  materializeClaimedCreation,
  publishCreation,
  serializeCreationIntent,
  recoverUnpublishedCreation,
} from './creation.js';

export {
  type ContractYaml,
  type ProgressData,
  type VerificationResult,
  type VerifierConfig,
  type VerifierResult,
};

/** Phase 1201 Step C: queued boot reset mutation outcome。 */
type BootResetOutcome =
  | { kind: 'done'; resetIds: string[]; progress: ProgressData }
  | { kind: 'not_active' }
  | { kind: 'schema_failed' };

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
  /** phase 1862 Step D (CT-D4): typed verifier runner 注入（owner 语义 request/raw result）。 */
  runVerifier?: VerifierConfig['runVerifier'];
  /**
   * phase 1445 Step D（裁定②例外）：boot reconcile（init()）由工厂内参数触发。
   * 仅 daemon 装配主路径（core-infrastructure、自有 claw）传 true；
   * CLI / watchdog narrow sink / claw-contract-bridge / summon contractQuery 等旁路实例
   * （只读或单方法用途、acting on 其他 claw 目录）不传——boot reconcile 是 owner-daemon
   * 的职责，旁路实例故意不 init（实核 2026-08-20，详 coding plan/phase1445/Step D §4.1）。
   */
  bootReconcile?: boolean;
}

export class ContractSystem implements ContractRuntimeLifecycle {
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
  private runVerifier?: VerifierConfig['runVerifier'];
  private activeDir = CONTRACT_ACTIVE_DIR;
  private pausedDir = CONTRACT_PAUSED_DIR;
  private archiveDir: ArchiveDir = makeArchiveDir(CONTRACT_ARCHIVE_DIR);
  onNotify?: ContractNotificationSink;

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
   * Phase 1201 Step A: per-contract FIFO progress mutation queue.
   * Owner = ContractSystem（progress 业务语义与资源所有权归此）；queue key 是
   * contractId（资源粒度 = 整份 progress.json）。Step B/C 起全部 published
   * active progress 短事务经 `_enqueueProgressMutation` 调度。
   */
  private readonly progressMutationQueue: ProgressMutationQueue;

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
        // unsafe abort: 容错防破 cancelContract 主流程。
        // phase 1862 Step B (CT-D5): abort 失败是独立执行失败事实，
        // 不再以无 reason 的 cancelled 行承载（避免与真实取消请求混淆）。
        emitVerifierAbortFailed(
          this.audit,
          {
            contractId,
            reason,
            error: formatErr(abortErr),
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
    this.runVerifier = deps.runVerifier;
    this.progressMutationQueue = new ProgressMutationQueue(this.audit);

  }

  setOnNotify(sink: ContractNotificationSink): void {
    this.onNotify = sink;
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

  /** Phase 1201 Step C: durable verification outcome store 归 ContractSystem（M#3）。 */
  private _persistVerificationOutcome(outcome: VerificationOutcomeIntent): Promise<PersistVerificationOutcomeResult> {
    return persistVerificationOutcome(this.fs, this.audit, this.clawDir, outcome);
  }

  /**
   * Phase 1201 Step C: boot replay durable verification outcomes。
   *
   * 顺序契约：init() 在 reset 遗留 in_progress 之前调用本方法；replay 经同一
   * per-contract queue + attempt guard，只应用 progress fact（success
   * audit/notify/inbox 等 process-local side effect 不在 boot 重放——无法证明
   * 未投递，不伪称 exactly-once）。重复 boot 由 already_applied 分类保证幂等。
   */
  private async _replayVerificationOutcomes(contractId: ContractId): Promise<void> {
    const { outcomes } = await readVerificationOutcomesForContract(this.fs, this.audit, this.clawDir, contractId);
    for (const outcome of outcomes) {
      const replay = await this._enqueueProgressMutation(
        contractId,
        { mutationId: `boot-replay-${outcome.attempt_id}-${newShortUuid()}`, kind: 'boot_replay' },
        async (): Promise<{ result: 'replayed' | 'already_applied' | 'superseded' | 'not_active' | 'invalid'; detail?: string }> => {
          const activeLoc = await resolveActiveContractLocation({
            fs: this.fs,
            activeDir: this.activeDir,
            contractId,
          });
          if (!activeLoc) return { result: 'not_active' };
          const readResult = await this._readActiveProgressForMutation(contractId, activeLoc);
          if (readResult === 'not_active') return { result: 'not_active' };
          if (!readResult) return { result: 'invalid', detail: 'progress unavailable' };
          const progress = readResult;
          const subtask = progress.subtasks[outcome.subtask_id];
          if (!subtask) return { result: 'invalid', detail: 'subtask missing from progress' };

          if (subtask.status === 'in_progress' && subtask.verification_attempt_id === outcome.attempt_id) {
            // 应用 durable fact（与 typed transition 等价的 mutation 语义）。
            if (outcome.kind === 'passed') {
              subtask.status = 'completed';
              subtask.completed_at = outcome.completed_at;
            } else if (outcome.kind === 'rejected' || outcome.kind === 'errored') {
              const feedback = outcome.kind === 'rejected' ? outcome.result.feedback : outcome.feedback;
              subtask.retry_count = (subtask.retry_count ?? 0) + 1;
              subtask.last_failed_feedback = { feedback, cause: outcome.cause };
              if (subtask.retry_count >= outcome.max_attempts) {
                subtask.status = 'completed';
                subtask.completed_at = outcome.completed_at;
                subtask.force_accepted = true;
              } else {
                subtask.status = 'todo';
              }
            } else {
              subtask.status = 'todo';
              delete subtask.verification_attempt_id;
            }
            const stillActive = await resolveActiveContractLocation({
              fs: this.fs,
              activeDir: this.activeDir,
              contractId,
            });
            if (!stillActive) return { result: 'not_active' };
            try {
              await this.saveActiveProgressExisting(contractId, progress);
            } catch (err) {
              if (isFileNotFound(err)) return { result: 'not_active' };
              throw err;
            }
            return { result: 'replayed' };
          }

          // idempotent replay（已应用）vs superseded（新 attempt 已取代）。
          if (isOutcomeAlreadyApplied(subtask, outcome)) return { result: 'already_applied' };
          return { result: 'superseded' };
        },
      );
      emitVerificationOutcomeReplay(this.audit, {
        contractId,
        subtaskId: outcome.subtask_id,
        attemptId: outcome.attempt_id,
        outcomeKind: outcome.kind,
        result: replay.result,
        ...(replay.detail !== undefined ? { detail: replay.detail } : {}),
      });
    }
  }

  // ============================================================================
  // Phase 1201 Step A: progress mutation queue delegate
  // ============================================================================

  /**
   * 唯一 progress 短事务调度入口（private owner delegate）。
   * Phase 1201 Step E: 收窄为 private——production caller 只能经 typed 业务
   * capability（transitionVerificationAttempt / submitSyncCompletion / boot）
   * 间接调度，不暴露 arbitrary callback enqueue 表面。
   * mutation callback 必须在执行时 fresh-read（不接受 caller 预读 snapshot）、
   * 不得包含长耗时 verifier/LLM/script 或 terminal side effect 等待。
   */
  private async _enqueueProgressMutation<T>(
    contractId: ContractId,
    meta: ProgressMutationMeta,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.progressMutationQueue.enqueue(contractId, meta, mutation);
  }

  // ============================================================================
  // Phase 1136 Step B: layout-neutral verification resource gateway
  // ============================================================================

  async isActiveContract(contractId: ContractId): Promise<boolean> {
    const loc = await resolveActiveContractLocation({
      fs: this.fs,
      activeDir: this.activeDir,
      contractId,
    });
    return loc !== null;
  }

  /**
   * Phase 1396 Step B: 创建事实核实 —— contract 是否已在本 claw 提交
   * （active 或任一 archive 位置）。供 SummonSystem 等 caller 在回执丢失后
   * 核实 claim 指向的 contract 是否真实存在；只读，不产生副作用。
   */
  async hasContract(contractId: ContractId): Promise<boolean> {
    const loc = await resolveContractLocation({
      fs: this.fs,
      activeDir: this.activeDir,
      archiveDir: this.archiveDir,
      contractId,
      audit: this.audit,
    });
    return loc !== null;
  }

  async getContractRoot(contractId: ContractId): Promise<string> {
    const activeLoc = await resolveActiveContractLocation({
      fs: this.fs,
      activeDir: this.activeDir,
      contractId,
    });
    if (activeLoc) {
      return activeLoc.contractRoot;
    }
    const loc = await resolveContractLocation({
      fs: this.fs,
      activeDir: this.activeDir,
      archiveDir: this.archiveDir,
      contractId,
      audit: this.audit,
    });
    if (!loc) throw new ToolError(`Contract "${contractId}" not found`);
    return loc.contractRoot;
  }

  async transitionVerificationAttempt(
    contractId: ContractId,
    subtaskId: SubtaskId,
    transition: VerificationAttemptTransition,
  ): Promise<VerificationGatewayResult> {
    // Phase 1201 Step B: 全部 attempt transition 经 per-contract queue 串行，
    // callback 执行时 fresh-resolve active + fresh-read progress。
    const kind = transition.kind === 'start'
      ? 'attempt_start'
      : transition.kind === 'pass'
        ? 'attempt_pass'
        : transition.kind === 'reject'
          ? 'attempt_reject'
          : 'attempt_interrupt';
    return this._enqueueProgressMutation(
      contractId,
      { mutationId: `${transition.kind}-${newShortUuid()}`, kind },
      async () => {
        const activeLoc = await resolveActiveContractLocation({
          fs: this.fs,
          activeDir: this.activeDir,
          contractId,
        });

        if (activeLoc) {
          return this.transitionLegacyVerificationAttempt(contractId, subtaskId, transition, activeLoc);
        }

        return { kind: 'skipped', reason: `contract ${contractId} is not active` };
      },
    );
  }

  /**
   * Phase 1201 Step B/C: queued mutation 共用的 active progress fresh-read。
   * read ENOENT 时 re-resolve：active 已消失 → 'not_active'（rename 胜出，
   * fail-closed）；active 仍在 → 真 corruption，上抛。
   */
  private async _readActiveProgressForMutation(
    contractId: ContractId,
    activeLoc: ActiveContractLocation,
  ): Promise<ProgressData | null | 'not_active'> {
    try {
      return await this._getLegacyActiveProgress(contractId, activeLoc.contractRoot);
    } catch (err) {
      if (isFileNotFound(err)) {
        const stillActive = await resolveActiveContractLocation({
          fs: this.fs,
          activeDir: this.activeDir,
          contractId,
        });
        if (!stillActive) return 'not_active';
      }
      throw err;
    }
  }

  private async transitionLegacyVerificationAttempt(
    contractId: ContractId,
    subtaskId: SubtaskId,
    transition: VerificationAttemptTransition,
    activeLoc: ActiveContractLocation,
  ): Promise<VerificationGatewayResult> {
    // Phase 1201 Step B: active-only read —— queued callback 不得 fallback 读
    // archive progress（rename 竞争时 getProgress 会读到 archive view）。
    const readResult = await this._readActiveProgressForMutation(contractId, activeLoc);
    if (readResult === 'not_active') {
      return { kind: 'skipped', reason: `contract ${contractId} is not active` };
    }
    const progress = readResult;
    if (!progress) {
      return { kind: 'skipped', reason: `progress unavailable for ${contractId}` };
    }

    const subtask = progress.subtasks[subtaskId];
    if (!subtask) {
      return { kind: 'skipped', reason: `subtask ${subtaskId} missing from progress` };
    }

    if (transition.kind === 'start') {
      if (subtask.status !== 'todo') {
        return { kind: 'skipped', reason: `start requires todo, got ${subtask.status}` };
      }
      subtask.status = 'in_progress';
      subtask.evidence = transition.evidence;
      subtask.artifacts = transition.artifacts;
      subtask.verification_attempt_id = transition.attemptId;
    } else if (transition.kind === 'pass') {
      if (subtask.status === 'in_progress' && subtask.verification_attempt_id !== transition.attemptId) {
        // Phase 1201 Step C: 旧 attempt 的 outcome 晚到新 attempt —— late/superseded，
        // durable fact 保留、progress 不被覆盖。
        return { kind: 'late', expectedAttemptId: transition.attemptId, actualAttemptId: subtask.verification_attempt_id };
      }
      if (subtask.status !== 'in_progress' || subtask.verification_attempt_id !== transition.attemptId) {
        return { kind: 'skipped', reason: 'attempt id mismatch or subtask not in_progress' };
      }
      subtask.status = 'completed';
      subtask.completed_at = transition.at;
    } else if (transition.kind === 'reject') {
      if (subtask.status === 'in_progress' && subtask.verification_attempt_id !== transition.attemptId) {
        return { kind: 'late', expectedAttemptId: transition.attemptId, actualAttemptId: subtask.verification_attempt_id };
      }
      if (subtask.status !== 'in_progress' || subtask.verification_attempt_id !== transition.attemptId) {
        return { kind: 'skipped', reason: 'attempt id mismatch or subtask not in_progress' };
      }
      // Phase 1201 Step B: forceAccept 由 queued mutation 基于 fresh retry_count 计算，
      // 不由 caller 的 queue 外预读快照决定。
      const forceAccept = (subtask.retry_count ?? 0) + 1 >= transition.maxAttempts;
      subtask.retry_count = (subtask.retry_count || 0) + 1;
      subtask.last_failed_feedback = { feedback: transition.feedback, cause: transition.cause };
      if (forceAccept) {
        subtask.status = 'completed';
        subtask.completed_at = transition.at;
        subtask.force_accepted = true;
      } else {
        subtask.status = 'todo';
      }
    } else if (transition.kind === 'interrupt') {
      if (subtask.status === 'in_progress' && subtask.verification_attempt_id !== transition.attemptId) {
        return { kind: 'late', expectedAttemptId: transition.attemptId, actualAttemptId: subtask.verification_attempt_id };
      }
      if (subtask.status !== 'in_progress' || subtask.verification_attempt_id !== transition.attemptId) {
        return { kind: 'skipped', reason: 'attempt id mismatch or subtask not in_progress' };
      }
      subtask.status = 'todo';
      delete subtask.verification_attempt_id;
    }

    // Phase 1201 Step B: terminal rename 可与 queued mutation 竞争；写前 re-verify
    // active，rename loser 不得在 archive 中写 progress。
    const stillActive = await resolveActiveContractLocation({
      fs: this.fs,
      activeDir: this.activeDir,
      contractId,
    });
    if (!stillActive) {
      return { kind: 'skipped', reason: `contract ${contractId} is not active` };
    }
    try {
      await this.saveActiveProgressExisting(contractId, progress);
    } catch (err) {
      // rename 在 re-verify 后胜出：active 目录已消失，fail-closed 不写 archive。
      if (isFileNotFound(err)) {
        return { kind: 'skipped', reason: `contract ${contractId} is not active` };
      }
      throw err;
    }
    return { kind: 'updated', progress };
  }

  /**
   * Phase 1201 Step B: queued sync-completion capability。
   * 整段 RMW（resolve active → fresh-read → validate → mutate → save）在
   * per-contract queue callback 内完成；post-commit audit/notify/archive 由
   * caller（verification-lifecycle.completeSubtaskSync）基于返回结果执行。
   */
  async _submitSyncCompletion(
    contractId: ContractId,
    subtaskId: SubtaskId,
    facts: { evidence: string; artifacts?: string[]; at: string },
  ): Promise<SyncCompletionGatewayResult> {
    return this._enqueueProgressMutation(
      contractId,
      { mutationId: `sync-${newShortUuid()}`, kind: 'sync_complete' },
      async () => {
        const activeLoc = await resolveActiveContractLocation({
          fs: this.fs,
          activeDir: this.activeDir,
          contractId,
        });
        if (!activeLoc) {
          return { kind: 'not_active' };
        }

        // rename 在 resolve 后胜出时 read ENOENT → fail-closed not_active。
        const readResult = await this._readActiveProgressForMutation(contractId, activeLoc);
        if (readResult === 'not_active') {
          return { kind: 'not_active' };
        }
        const progress = readResult;
        if (!progress) {
          throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
        }

        const subtask = progress.subtasks[subtaskId];
        if (!subtask) {
          return { kind: 'unknown_subtask', validIds: formatValidIds(progress) };
        }
        if (subtask.status === 'in_progress') {
          return { kind: 'duplicate' };
        }
        if (subtask.status === 'completed') {
          return { kind: 'already_completed' };
        }

        progress.subtasks[subtaskId] = {
          ...subtask,
          status: 'completed',
          completed_at: facts.at,
          evidence: facts.evidence,
          artifacts: facts.artifacts,
        };
        const allCompleted = await this.checkAllCompleted(contractId, progress);
        if (allCompleted) {
          progress.completed_at = facts.at;
        }

        // 同 transition：写前 re-verify active（rename 竞争 fail-closed）。
        const stillActive = await resolveActiveContractLocation({
          fs: this.fs,
          activeDir: this.activeDir,
          contractId,
        });
        if (!stillActive) {
          return { kind: 'not_active' };
        }
        try {
          await this.saveActiveProgressExisting(contractId, progress);
        } catch (err) {
          // rename 在 re-verify 后胜出：fail-closed 不写 archive。
          if (isFileNotFound(err)) {
            return { kind: 'not_active' };
          }
          throw err;
        }
        return { kind: 'completed', progress, allCompleted };
      },
    );
  }

  // ============================================================================
  // ctx 装配 helper
  // ============================================================================

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
      fs: this.fs,
      audit: this.audit,
      baseDir: this.clawDir,
      activeDir: this.activeDir,
      archiveDir: this.archiveDir,
      contractDir: (id) => this.contractDir(id),
      loadContract: (id) => this.loadContractYaml(id),
      getProgress: (id) => this.getProgress(id),
      checkAllSubtasksCompleted: (id, p) => this.checkAllCompleted(id, p),
      abortContractVerifiers: (id, reason) => this._abortContractVerifiers(id, reason),
      // phase 438: lazy thunk、setOnNotify 后的回调能在 ctx 已分发场景下生效（review N3-C-H3 / R2-C-N18）
      onNotify: (event) => this.onNotify?.(event),
    };
  }

  private _verificationCtx(signal?: AbortSignal): VerificationContext {
    const self = this;
    return {
      fs: this.fs,
      audit: this.audit,
      clawDir: this.clawDir,
      clawId: this.clawId,
      // phase 104: caller pre-bound、直接 forward
      notifyClaw: this.notifyClaw,
      llm: this.llm,
      contractDir: (id) => this.contractDir(id),
      loadContractYaml: (id) => this.loadContractYaml(id),
      getProgress: (id) => this.getProgress(id),
      submitSyncCompletion: (id, stId, facts) => this._submitSyncCompletion(id, stId, facts),
      persistVerificationOutcome: (outcome) => this._persistVerificationOutcome(outcome),
      checkAllSubtasksCompleted: (id, p) => this.checkAllCompleted(id, p),
      baseDir: this.clawDir,
      activeDir: this.activeDir,
      archiveDir: this.archiveDir,
      abortContractVerifiers: (id, reason) => this._abortContractVerifiers(id, reason),
      emitContractCompleted: (id) => this._emitContractCompleted(id),
      isActiveContract: (id) => this.isActiveContract(id),
      getContractRoot: (id) => this.getContractRoot(id),
      transitionVerificationAttempt: (id, stId, t) => this.transitionVerificationAttempt(id, stId, t),
      // phase 438: lazy thunk、同 _lifecycleCtx
      onNotify: (event) => this.onNotify?.(event),
      // Phase 965: propagate cancellation signal to verification execution
      signal,
      runScriptVerification: function(scriptFile: string, contractAbsDir: string) {
        return self.runScriptVerification(scriptFile, contractAbsDir, this.signal);
      },
      runLLMVerification: function(promptFile: string, contractAbsDir: string, contractId: ContractId, subtaskId: SubtaskId, subtaskDesc: string, evidence: string, artifacts: string[]) {
        return self.runLLMVerification(promptFile, contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts, this.signal);
      },
      toolRegistry: this.toolRegistry,
      toolTimeoutMs: this.toolTimeoutMs,
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
    // Phase 1132 Step E: boot reconcile derives all state from active path + subtask facts.
    this.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
      'recovered=false',
    );

    let failedCount = 0;

    // Phase 1197 Step B: recover durable creation intents before normal active reconcile.
    if (await this.fs.exists(this.activeDir)) {
      const allEntries = await this.fs.list(this.activeDir, { includeDirs: true });
      for (const entry of allEntries) {
        if (!entry.isDirectory) continue;
        const contractId = makeContractId(entry.name);
        if (await this.fs.exists(`${this.activeDir}/${contractId}/${CREATION_CLAIM_FILE}`)) {
          try {
            await recoverUnpublishedCreation({
              fs: this.fs,
              audit: this.audit,
              activeDir: this.activeDir,
              archiveDir: this.archiveDir,
              contractId,
            });
          } catch (err) {
            this.audit.write(
              CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE_SKIPPED,
              `contract=${contractId}`,
              `error=${formatErr(err)}`,
            );
            failedCount++;
          }
        }
      }
    }

    if (await this.fs.exists(this.activeDir)) {
      const activeIds = await listPhysicalActiveContractIds({
        fs: this.fs,
        activeDir: this.activeDir,
      });

      for (const contractId of activeIds) {
        try {
          // Phase 1198 Step D: replay any pending lifecycle intents before active reconcile.
          // If a terminal intent wins the rename race, the contract is no longer active.
          const reconcileResult = await reconcilePendingLifecycleIntents(
            this._lifecycleCtx(),
            contractId,
          );
          if (reconcileResult.committed) {
            continue;
          }

          // Phase 1399: migrate legacy 'escalated' subtask status -> completed + force_accepted.
          // Use the loose archive schema because strict active schema no longer recognises
          // 'escalated'; after migration strict getProgress will succeed.
          const activeProgressPath = `${this.activeDir}/${contractId}/progress.json`;
          if (await this.fs.exists(activeProgressPath)) {
            try {
              const raw = await this.fs.read(activeProgressPath);
              const loose = ContractProgressArchiveLooseSchema.safeParse(JSON.parse(raw));
              if (loose.success && loose.data.subtasks) {
                let migrated = false;
                for (const [stId, st] of Object.entries(loose.data.subtasks)) {
                  const stRecord = st as Record<string, unknown>;
                  if (stRecord.status === 'escalated') {
                    stRecord.status = 'completed';
                    stRecord.force_accepted = true;
                    delete stRecord.escalated_at;
                    if (!stRecord.completed_at) stRecord.completed_at = new Date().toISOString();
                    migrated = true;
                    this.audit.write(
                      CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_MIGRATE_ESCALATED,
                      `contractId=${contractId}`,
                      `subtaskId=${stId}`,
                    );
                  }
                }
                if (migrated) {
                  // Phase 1201 Step E: active progress 写一律 existing-parent，
                  // rename 先胜出时 ENOENT（下方 catch 静默，不 ghost-recreate）。
                  await this.fs.writeAtomicExisting(activeProgressPath, JSON.stringify(loose.data, null, 2));
                }
              }
            } catch {
              // silent: best-effort legacy migration; strict getProgress below will surface real corruption.
            }
          }

          // Phase 1201 Step C: replay durable verification outcomes BEFORE reset.
          // boot 先 replay 已持久化的 verifier 计算事实（queued + attempt guard），
          // 再 reset 没有可重放结果的遗留 in_progress attempt。
          await this._replayVerificationOutcomes(contractId);

          // Phase 1201 Step B/C: boot reset 也经 per-contract queue（fresh-read、
          // rename 竞争 fail-closed）。
          const bootReset = await this._enqueueProgressMutation(
            contractId,
            { mutationId: `boot-reset-${newShortUuid()}`, kind: 'boot_reset' },
            async (): Promise<BootResetOutcome> => {
              const activeLoc = await resolveActiveContractLocation({
                fs: this.fs,
                activeDir: this.activeDir,
                contractId,
              });
              if (!activeLoc) return { kind: 'not_active' };
              const readResult = await this._readActiveProgressForMutation(contractId, activeLoc);
              if (readResult === 'not_active') return { kind: 'not_active' };
              const progress = readResult;
              if (!progress) return { kind: 'schema_failed' };

              // Phase 966 / 1132 Step E: reset leftover in_progress subtasks based on subtask fact
              const resetIds: string[] = [];
              for (const [stId, subtask] of Object.entries(progress.subtasks)) {
                if (subtask.status === 'in_progress') {
                  subtask.status = 'todo';
                  delete subtask.verification_attempt_id;
                  resetIds.push(stId);
                }
              }

              if (resetIds.length > 0) {
                const stillActive = await resolveActiveContractLocation({
                  fs: this.fs,
                  activeDir: this.activeDir,
                  contractId,
                });
                if (!stillActive) return { kind: 'not_active' };
                try {
                  // Phase 970: save progress FIRST so audit failures cannot block the reset.
                  await this.saveActiveProgressExisting(contractId, progress);
                } catch (err) {
                  if (isFileNotFound(err)) return { kind: 'not_active' };
                  throw err;
                }
              }
              return { kind: 'done', resetIds, progress };
            },
          );

          if (bootReset.kind === 'schema_failed') {
            this.audit.write(
              CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_SCHEMA_FAILED,
              `contract=${contractId}`,
              'reason=schema_parse_failed',
            );
            failedCount++;
            continue;
          }
          if (bootReset.kind === 'not_active') {
            continue;
          }

          const progress = bootReset.progress;
          for (const stId of bootReset.resetIds) {
            try {
              this.audit.write(
                CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET,
                `contract=${contractId}`,
                `subtask=${stId}`,
              );
            } catch {
              // best-effort audit: leave stderr trace for diagnosis
              process.stderr.write(`[contract] boot reconcile in_progress reset audit failed for ${contractId}/${stId}\n`);
            }
          }

          // Phase 1132 Step E: active all-subtasks-completed -> retry completed archive
          if (deriveProgressStatus(progress) === 'completed') {
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
              await archiveAndEmit(this._verificationCtx(), contractId, contractYaml, 'init.completedActiveRetry');
            }
          }
        } catch (err) {
          this.audit.write(
            CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE_SKIPPED,
            `contract=${contractId}`,
            `error=${formatErr(err)}`,
          );
          failedCount++;
        }
      }
    }

    if (failedCount > 0) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
        `schema_failed_count=${failedCount}`,
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

    // phase 1127 Step E: migrate classified legacy flat archive entries to typed state dirs.
    try {
      await migrateLegacyArchiveEntries(
        { fs: this.fs, audit: this.audit },
        this.clawId,
        this.clawDir,
      );
    } catch (err) {
      // migrator 内已 catch + audit emit；此处兜底
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATION_FAILED,
        `clawId=${this.clawId}`,
        `contractId=<init_outer_catch>`,
        `context=init_outer_catch`,
        `error=${formatErr(err)}`,
      );
    }
  }

  // Verification
  createSubmitSubtaskTool(): Tool {
    return buildSubmitSubtaskTool({
      loadForeground: () => this.loadActive(),
      submit: (params: SubmitSubtaskParams) => this.submitSubtaskInternal(params),
    });
  }

  private submitSubtaskInternal(params: SubmitSubtaskParams): Promise<VerificationResult> {
    return runVerificationPipeline(this._verificationCtx(), params);
  }

  // Lifecycle
  // phase 1862 Step C (CT-D2): 终态 transition 返回单一 typed outcome（commit + postCommit 事实）。
  async cancel(contractId: ContractId, reason: string): Promise<TerminalTransitionOutcome> {
    const outcome = await cancelContract(this._lifecycleCtx(), contractId, reason);
    // phase 398 Step D (review N9): 终态清 auditorState、防 unbounded growth +
    // contract-id 复用残留。cancel 失败 throw、entry 留待重试。
    this.auditorState.delete(contractId);
    return outcome;
  }

  async markCorrupted(
    contractId: ContractId,
    evidence: ContractCorruptionEvidence,
    knownDir?: string,
  ): Promise<TerminalTransitionOutcome> {
    const outcome = await markCorrupted(this._lifecycleCtx(), contractId, evidence, knownDir);
    // phase 398 Step D (review N9): 同 cancel。
    this.auditorState.delete(contractId);
    return outcome;
  }

  /**
   * Phase 1396 Step D: ContractSystem-owned execution-failure terminal commit.
   *
   * Reporters submit the failure fact only; the intent + rename winner protocol
   * decides the outcome. cancelled is never used to express execution failure.
   */
  async fail(
    contractId: ContractId,
    failure: ContractFailure,
    requestId?: string,
  ): Promise<TerminalTransitionOutcome> {
    const outcome = await failContract(this._lifecycleCtx(), contractId, failure, requestId);
    // 同 cancel / markCorrupted：终态清 auditorState。
    this.auditorState.delete(contractId);
    return outcome;
  }

  /**
   * Phase 1396 Step D: fail all active contracts owned by this executor.
   *
   * ContractSystem 自己枚举/核实 active contract（按 sorted id deterministic
   * 顺序逐个走 fail() 的 intent + rename winner 协议）；调用者只传 executor
   * identity + failure fact，不得传 contract 路径或执行 rename。executorId 与
   * 本 claw 不一致时拒绝并留 audit（下层不得跨边界改写别的 executor 的资源）。
   *
   * Phase 1803 Step B: 对外返回 typed ExecutionFailureReportOutcome。
   * terminal winner 已确定（committed / already_committed / lost_to_state）
   * 或无 active contract → committed；任一 contract 本轮 retryable →
   * retryable{error}（携带原始 cause），报告方保留证据后重试；executor
   * mismatch → rejected{reason}（永久拒绝，重试无意义）。单个 retryable 不
   * 阻断本轮其他 active contract。相同 contract + executor + producer +
   * reason + evidenceRef 派生稳定 requestId，at-least-once 重试复用同一
   * intent。意外异常（fs 故障等）仍以 rejection 上抛，不并入 outcome。
   */
  async failActiveForExecutor(
    input: ContractExecutionFailure,
  ): Promise<ExecutionFailureReportOutcome> {
    if (input.executorId !== this.clawId) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.FAIL_EXECUTOR_MISMATCH,
        `executorId=${input.executorId}`,
        `clawId=${this.clawId}`,
        `producer=${input.failure.producer}`,
      );
      return {
        kind: 'rejected',
        reason: `Execution failure report rejected: executor "${input.executorId}" does not own this ContractSystem (claw "${this.clawId}")`,
      };
    }

    const activeIds = await listPhysicalActiveContractIds({
      fs: this.fs,
      activeDir: this.activeDir,
    });

    let retryable: TerminalTransitionOutcome | null = null;
    for (const contractId of activeIds) {
      const outcome = await this.fail(
        contractId,
        input.failure,
        executionFailureRequestId(contractId, input),
      );
      // 单个 retryable 只记录本轮未闭合，不阻断其他 active contract。
      if (outcome.commit.kind === 'retryable_failure' && retryable === null) {
        retryable = outcome;
      }
    }
    if (retryable !== null) {
      const commit = retryable.commit;
      return {
        kind: 'retryable',
        error: `Execution failure not closed this round: ${commit.kind === 'retryable_failure' ? commit.cause : 'unknown'}`,
      };
    }
    return { kind: 'committed' };
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

    if (contractYaml.id !== undefined && contractYaml.id.trim() === '') {
      throw new ContractValidationError('id', 'empty',
        'contract id must not be empty (yaml: id: "<not blank>")');
    }
    const contractId = makeContractId(contractYaml.id || `${Date.now()}-${newShortUuid()}`);

    // Phase 956: preflight uniqueness check across current directories (active + archive states + legacy flat).
    // phase 1123 Step C: paused/ is legacy-only and must not block creation.
    // phase 1127 Step B: creation must not collide with any current archive state container or legacy flat entry.
    // Phase 1197: preflight is friendly diagnostic only; real authority comes from exclusive claim.
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

    // Phase 230 / phase 1396 Step B: policy iteration 移到 schema/ID 规范化之后、
    // creation claim publish 之前 —— policy 拿到的是规范化 proposedContractId，
    // 无效 YAML 不会污染 policy 的 durable caller correlation（如 summon 0/1 claim）。
    // policy 仍只返回 void：通过 = void、拒 = throw ContractCreatePolicyViolationError。
    const ctx: CreatePolicyContext = {
      subagentTaskId: opts.subagentTaskId,
      clawDir: opts.clawDir,
      proposedContractId: contractId,
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

    const startedAt = new Date().toISOString();
    const intent = buildCreationIntent(contractYaml, contractId, startedAt);

    // Phase 1197: exclusive claim grants creation authority.
    try {
      await this.fs.writeExclusive(
        `${this.activeDir}/${contractId}/${CREATION_CLAIM_FILE}`,
        serializeCreationIntent(intent),
      );
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new ContractValidationError('id', 'already_exists',
          `contract id "${contractId}" already exists`,
          { contractId });
      }
      throw error;
    }

    emitContractCreationClaimed(this.audit, { contractId, startedAt });

    // Recheck archive collision after claim (another process may have archived the same id).
    const collisionAfterClaim = await findArchiveCollisionLocation({
      fs: this.fs,
      archiveDir: this.archiveDir,
      contractId,
    });
    if (collisionAfterClaim) {
      emitContractCreationInterrupted(this.audit, {
        contractId,
        startedAt,
        boundary: 'archive_collision_recheck',
        error: `contract id "${contractId}" already exists in ${path.basename(collisionAfterClaim)}`,
      });
      throw new ContractValidationError('id', 'already_exists',
        `contract id "${contractId}" already exists in ${path.basename(collisionAfterClaim)}`,
        { contractId });
    }

    try {
      await materializeClaimedCreation({ fs: this.fs, activeDir: this.activeDir, contractId, intent });
      await publishCreation({ fs: this.fs, activeDir: this.activeDir, contractId });
    } catch (err) {
      emitContractCreationInterrupted(this.audit, {
        contractId,
        startedAt,
        boundary: 'materialize_or_publish',
        error: formatErr(err),
      });
      throw err;
    }

    try {
      this.onNotify?.({
        type: 'contract_created',
        contractId,
        title: contractYaml.title,
        subtaskCount: contractYaml.subtasks.length,
      } satisfies ContractNotification);
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
  }

  /**
   * 读 contract progress。
   *
   * Phase 1193 Step A: active runtime uses the single `active/<id>` layout with
   * progress.json. Archive payloads continue to support current/legacy dual-format
   * via readArchivePayload.
   *
   * TOCTOU mitigation: active→archive / archive→active race 通过单次重试回到顶层
   * dispatcher；持久双位置仍 fail-closed。
   */
  async getProgress(contractId: ContractId): Promise<ProgressData | null> {
    return this._getProgressWithRetry(contractId, 0);
  }

  private async _getProgressWithRetry(contractId: ContractId, retry: number): Promise<ProgressData | null> {
    const activeLoc = await resolveActiveContractLocation({
      fs: this.fs,
      activeDir: this.activeDir,
      contractId,
    });
    if (activeLoc) {
      // Phase 956 regression guard: active must not simultaneously exist in archive.
      const archiveLoc = await resolveContractLocation({
        fs: this.fs,
        activeDir: this.activeDir,
        archiveDir: this.archiveDir,
        contractId,
        audit: this.audit,
      });
      if (archiveLoc && archiveLoc.kind !== 'active') {
        if (retry === 0) {
          // TOCTOU: contract moved to archive between the two resolves; retry once.
          return this._getProgressWithRetry(contractId, retry + 1);
        }
        const locations = [activeLoc.contractRoot, archiveLoc.contractRoot];
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_MULTI_DIR,
          `contractId=${contractId}`,
          `dirs=${locations.join(',')}`,
          `context=getProgress`,
        );
        throw new ContractLocationAmbiguityError(contractId, locations);
      }
      return this._getLegacyActiveProgress(contractId, activeLoc.contractRoot);
    }

    const loc = await resolveContractLocation({
      fs: this.fs,
      activeDir: this.activeDir,
      archiveDir: this.archiveDir,
      contractId,
      audit: this.audit,
    });
    if (!loc) return null;
    if (loc.kind === 'active') {
      // TOCTOU: contract became active after the first resolve; retry once from top.
      if (retry === 0) {
        return this._getProgressWithRetry(contractId, retry + 1);
      }
      const locations = [this.activeDir + '/' + contractId, loc.contractRoot];
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_MULTI_DIR,
        `contractId=${contractId}`,
        `dirs=${locations.join(',')}`,
        `context=getProgress`,
      );
      throw new ContractLocationAmbiguityError(contractId, locations);
    }

    const result = await readArchivePayload({
      fs: this.fs,
      audit: this.audit,
      location: loc,
      contractId,
      baseDir: this.clawDir,
    });
    if (result.kind === 'found') return result.view.progress;
    throw new ContractArchiveReadError(
      `failed to read archive payload for ${contractId}: ${result.issue.code}`,
      result.issue,
    );
  }

  private async _getLegacyActiveProgress(contractId: ContractId, contractRoot: string): Promise<ProgressData | null> {
    const progressPath = `${contractRoot}/${PROGRESS_FILE}`;
    let content: string;
    try {
      content = await this.fs.read(progressPath);
    } catch (err) {
      // phase 1862 Step E (CT-D6)：FNF 竞态 = retryable_io（不隔离、可重读）；其余原样上抛。
      if (classifyCorruption(err, { kind: 'progress' }).disposition !== 'retryable_io') throw err;
      // Legacy active progress.json should exist; one race retry for TOCTOU.
      content = await this.fs.read(progressPath);
    }
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(content);
    } catch (parseErr) {
      // phase 958 + 1862 Step E (CT-D6)：JSON.parse SyntaxError → 经单一 classify 判定
      // （schema 类 → isolate），隔离路径与 schema validation failure 相同。
      const classification = classifyCorruption(parseErr, { kind: 'progress' });
      if (classification.disposition === 'isolate') {
        this.audit.write(
          CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
          `contractId=${contractId}`,
          `reason=json_parse_failed`,
          `error=${formatErr(parseErr)}`,
        );
        const isolated = await isolateCorruptedFile(this.fs, this.audit, {
          contractId, contractDir: contractRoot, filename: PROGRESS_FILE,
          reason: isolationReasonFor(classification),
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
          reason: classification.reason as ContractCorruptionEvidence['reason'],
          relativePath: isolated.relativePath,
        }, path.dirname(contractRoot));
        return null;
      }
      throw parseErr;
    }

    // Step C: current progress.json no longer carries lifecycle status or contract_id.
    // Both are derive fields: contract_id from caller/dir, status from subtasks.
    const rawObj = rawParsed as Record<string, unknown>;
    const legacyContractId = rawObj.contract_id;
    if (legacyContractId !== undefined) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_CONTRACT_ID_FIELD_IGNORED,
        `contractId=${contractId}`,
        `legacy_contract_id=${String(legacyContractId)}`,
      );
      delete rawObj.contract_id;
    }
    const observedStatus = rawObj.status;
    if (observedStatus !== undefined) {
      this.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_STATUS_FIELD_IGNORED,
        `contractId=${contractId}`,
        `legacy_status=${String(observedStatus)}`,
      );
      delete rawObj.status;
    }

    // phase 319: Zod SoT safeParse (mirror phase 311 ContractYamlSchema pattern)
    // phase 1862 Step E (CT-D6)：schema 事实判定经单一 classifySchemaViolation。
    const result = ContractProgressPersistedSchema.safeParse(rawObj);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const classification = classifySchemaViolation('progress', firstIssue?.path[0]);
      const isSchemaVersionIssue = classification.reason === 'progress_unknown_schema_version';
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
      // phase 958: isolate corrupted progress.json first, then markCorrupted with known dir.
      // markCorrupted internally re-resolves contractDir via progress.json existence;
      // after isolation progress.json is gone, so pass the known dir to avoid orphan.
      const isolated = await isolateCorruptedFile(this.fs, this.audit, {
        contractId, contractDir: contractRoot, filename: PROGRESS_FILE,
        reason: isolationReasonFor(classification),
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
        reason: classification.reason as ContractCorruptionEvidence['reason'],
        relativePath: isolated.relativePath,
      }, path.dirname(contractRoot));
      return null;
    }

    // phase 282 Step A/B: derive status + contract_id from caller/dir/subtasks
    const derivedStatus = deriveProgressStatus({ subtasks: result.data.subtasks });
    return {
      ...result.data,
      contract_id: contractId,
      status: derivedStatus,
    };
  }

  // ============================================================================
  // private thin delegate（保 method 名 / tests white-box 调用面 + spy 保护）
  // ============================================================================


  private async loadContractYaml(contractId: ContractId): Promise<ContractYaml | null> {
    return loadYaml(this._persistenceCtx(), contractId);
  }

  async _writeVerificationError(contractId: ContractId, subtaskId: SubtaskId, error: unknown): Promise<{ archived?: boolean }> {
    return writeVerificationError(this._verificationCtx(), contractId, subtaskId, error);
  }

  private async loadContract(contractId: ContractId): Promise<Contract> {
    return loadCt(this._persistenceCtx(), contractId);
  }

  private async saveActiveProgressExisting(contractId: ContractId, progress: ProgressData): Promise<void> {
    return saveActiveProg(this._persistenceCtx(), contractId, progress, this.activeDir);
  }

  private async checkAllCompleted(contractId: ContractId, progress: ProgressData): Promise<boolean> {
    return checkAllSubtasksCompleted(this._persistenceCtx(), contractId, progress);
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
  async close(): Promise<ContractCloseOutcome> {
    // phase 687 (audit T2.4): 幂等 guard、防双调 duplicate CONTRACT_SYSTEM_CLOSED audit emit
    if (this._closed) return { alreadyClosed: true, failures: [] };
    this._closed = true;
    // phase 1860 (RT-D5)：close 失败证据经 typed outcome 返回、不再静默吞。
    const failures: string[] = [];
    // phase 517 B3: auditor 先 close（防 dispose 期间 fire-and-forget maybeAudit 又产生新 LLM call）
    if (this.auditor) {
      try {
        await this.auditor.close();
      } catch (e) {
        // phase 1860 (RT-D5)：auditor close 失败收证据、best-effort cleanup 语义不变（不阻其他 dispose）
        failures.push(formatErr(e));
      }
    }

    const terminationPromises: Promise<unknown>[] = [];
    for (const [, entries] of this._activeContractControllers) {
      for (const { controller, promise } of entries) {
        try {
          controller.abort();
        } catch (e) {
          // phase 1860 (RT-D5)：abort 失败收证据、不阻 dispose 流程
          failures.push(formatErr(e));
        }
        terminationPromises.push(promise);
      }
    }
    // phase 1860 (RT-D5)：termination promise rejection 不再静默——证据进 outcome。
    for (const result of await Promise.allSettled(terminationPromises)) {
      if (result.status === 'rejected') failures.push(formatErr(result.reason));
    }
    this._activeContractControllers.clear();
    this.contractCompletedCallbacks.clear();
    // audit emit close event (additive const)
    this.audit?.write(CONTRACT_AUDIT_EVENTS.CONTRACT_SYSTEM_CLOSED, `clawId=${this.clawId}`);
    return { alreadyClosed: false, failures };
  }
}


/**
 * ContractSystem 工厂 —— 严格对齐 ctor 7 参数
 *
 * 输入：clawDir / clawId / fs 必填；llm / runContractVerifier / runVerifier 可选
 * 输出：ContractSystem 实例
 * 边界：可选参数未传时运行期能力降级（见 design/modules/l4_contract_system.md §2.a）
 * 失败：不抛；能力降级延迟到方法调用
 *
 * phase 1445 Step D（裁定②例外）：`bootReconcile: true` 时工厂内 await init()
 * （boot reconcile 内化）；init 失败原样冒泡。默认 false 保持显式 init 语义。
 */
export async function createContractSystem(deps: ContractSystemDeps): Promise<ContractSystem> {
  const system = new ContractSystem(deps);
  if (deps.bootReconcile) {
    await system.init();
  }
  return system;
}

/**
 * Phase 1398 Step B: 稳定 requestId 派生。输入全部是已有持久事实
 * （contractId + executorId + producer + reason + evidenceRef），字段顺序固定；
 * 不使用 Date.now() 或随机数，at-least-once 重试复用同一 lifecycle intent。
 */
function executionFailureRequestId(
  contractId: ContractId,
  input: ContractExecutionFailure,
): string {
  return `execution-failure-${sha256Hex(JSON.stringify([
    contractId,
    input.executorId,
    input.failure.producer,
    input.failure.reason,
    input.failure.evidenceRef,
  ]))}`;
}
