// src/core/evolution-system/system.ts
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AsyncTaskSystem } from '../async-task-system/index.js';
import { ContractSystem } from '../contract/index.js';
import { createSkillSystem as defaultCreateSkillSystem } from '../../foundation/skill-system/index.js';
import { buildRetroSubagentPayload } from './retro-scheduler.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
import * as path from 'path';

import type { Message } from '../../foundation/llm-provider/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { listPendingRetrospectives, ackPendingRetrospective } from '../summon-system/index.js';
import type { ContractId } from '../contract/types.js';
import type { FullTaskId, PreparedSubagentSchedule } from '../async-task-system/types.js';
import {
  RetrospectiveStore,
  type RetrospectiveWorkItemV1,
} from './retrospective-store.js';

export interface EvolutionSystemDeps {
  fs: FileSystem;
  audit: AuditLog;
  taskSystem: AsyncTaskSystem;
  contractManager: ContractSystem;
  retroSubagentTimeoutMs?: number;   // default 600000ms (10 min)
  createSkillSystem?: typeof defaultCreateSkillSystem;
}

export interface RetroResult {
  status:
    | 'finished'
    | 'skipped_index_missing'
    | 'skipped_missing_completed_at'
    | 'error'
    | 'blocked'
    // Phase 1206 new disk-state dispositions
    | 'submitted'
    | 'already_submitted'
    | 'already_dispatching'
    | 'missing_work_item';
  detail?: string;
  taskId?: string;
  reason?: string;
}

/** Motion 侧资源（pending-retrospective 索引读取 + motion audit 路由）。 */
export interface MotionResources {
  /** Motion agent 根目录的 FileSystem */
  motionFs: FileSystem;
  /** Motion agent 根目录绝对路径 */
  motionBaseDir: string;
  /** Motion audit sink（与 deps.audit 区分） */
  motionAudit: AuditLog;
  /** Claws 基础目录 */
  clawsBaseDir: string;
}

/** target claw 构造 factory（运行期按 targetClaw 解析）。 */
export interface ClawFactories {
  /** 临时构建 target claw FileSystem 的 factory（assembly 注入 / 业务 0 触 L1 impl）*/
  clawFsFactory: (clawDir: string) => FileSystem;
  /** 临时构建 target claw ContractSystem 的 factory（assembly 注入 / 业务 0 触 L4 ctor）。
   *  factory 内部封装 createSystemAudit（避免 L2 audit instance leak 到业务）。 */
  clawContractManagerFactory: (clawDir: string, targetClaw: string, fs: FileSystem) => ContractSystem;
}

/** 调用方便组合：runRetroForContract 一次性收到 motion 资源 + claw factory 两组语义。 */
export interface MotionReviewContext extends MotionResources, ClawFactories {}

const LEGACY_STATE_FILE_PATH = '.evolution-system-state.json';

export class EvolutionSystem {
  private readonly store: RetrospectiveStore;

  constructor(private readonly deps: EvolutionSystemDeps) {
    this.store = new RetrospectiveStore({ fs: deps.fs, audit: deps.audit });
  }

  /**
   * Boot reconcile: migrate legacy rows, recover dispatching, and drive any
   * ready rows whose contracts are already completed.
   */
  async init(ctx: MotionReviewContext): Promise<void> {
    await this._observeLegacyStateFile(ctx.motionFs);
    await this.recoverRetrospectives(ctx);
  }

  private async _observeLegacyStateFile(motionFs: FileSystem): Promise<void> {
    const exists = await motionFs.exists(LEGACY_STATE_FILE_PATH).catch(() => false);
    if (exists) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_FILE_OBSERVED,
        `path=${LEGACY_STATE_FILE_PATH}`,
        `reason=phase1206_state_no_longer_authoritative`,
      );
    }
  }

  /**
   * Phase 1206 entry point: contract completion is a wake-up signal only.
   * The disk row is the single source of truth.
   */
  async notifyContractCompleted(
    contractId: ContractId,
    ctx: MotionReviewContext,
  ): Promise<RetroResult> {
    const disposition = await this.store.beginDispatch(contractId);
    if (disposition === 'submitted') return { status: 'already_submitted' };
    if (disposition === 'busy') return { status: 'already_dispatching' };
    if (disposition === 'missing') return { status: 'missing_work_item' };

    const item = await this.store.readDispatching(contractId);
    if (!item) {
      // Race: row moved or corrupt between beginDispatch and read.
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
        `contractId=${contractId}`,
        `state=dispatching`,
        `reason=row_disappeared_after_acquire`,
      );
      return { status: 'error', detail: 'dispatching_row_lost' };
    }

    const prepared = await this._buildPreparedRetroTask(item, ctx);
    let scheduled: { taskId: string; disposition: 'created' | 'existing' };
    try {
      scheduled = await this.deps.taskSystem.schedulePrepared('subagent', prepared);
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.SCHEDULE_FAILED,
        `contractId=${contractId}`,
        `taskId=${item.task_id}`,
        `error=${formatErr(e)}`,
      );
      return { status: 'error', detail: 'schedule_failed' };
    }

    try {
      await this.store.markSubmitted(contractId);
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_DISPATCH_SUBMITTED_FAILED,
        `contractId=${contractId}`,
        `taskId=${scheduled.taskId}`,
        `reason=${formatErr(e)}`,
      );
      return { status: 'error', detail: 'mark_submitted_failed' };
    }

    return { status: 'submitted', taskId: scheduled.taskId };
  }

  /**
   * Legacy entry point retained for backward compatibility during Step C.
   * Maps new disk-state dispositions to the previous RetroResult shape.
   */
  async runRetroForContract(
    contractId: ContractId,
    ctx: MotionReviewContext,
  ): Promise<RetroResult> {
    const result = await this.notifyContractCompleted(contractId, ctx);
    // Compatibility mapping for existing callers/tests.
    switch (result.status) {
      case 'submitted':
        return { ...result, status: 'finished' };
      case 'already_dispatching':
        return { status: 'blocked', reason: 'already_dispatching' };
      case 'missing_work_item':
        return { status: 'skipped_index_missing', detail: 'missing work item' };
      default:
        return result;
    }
  }

  /**
   * Recover from disk on startup:
   * 1. Migrate legacy pending-retrospective rows.
   * 2. Re-submit any dispatching rows (crash after move, before markSubmitted).
   * 3. Drive ready rows whose contracts are completed.
   */
  async recoverRetrospectives(ctx: MotionReviewContext): Promise<{
    migrated: number;
    failed: number;
    recovered: number;
    driven: number;
  }> {
    const migration = await this.store.migrateLegacyRows(
      () => listPendingRetrospectives({ fs: ctx.motionFs }),
      (contractId) => ackPendingRetrospective({ fs: ctx.motionFs, contractId, audit: ctx.motionAudit }),
    );

    let recovered = 0;
    const dispatching = await this.store.listDispatching();
    for (const item of dispatching) {
      try {
        const result = await this.notifyContractCompleted(item.contract_id, ctx);
        if (result.status === 'submitted' || result.status === 'already_submitted') {
          recovered++;
        }
      } catch (e) {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED,
          `contractId=${item.contract_id}`,
          `state=dispatching`,
          `reason=${formatErr(e)}`,
        );
      }
    }

    let driven = 0;
    const ready = await this.store.listReady();
    for (const item of ready) {
      try {
        if (await this._isContractCompleted(item, ctx)) {
          const result = await this.notifyContractCompleted(item.contract_id, ctx);
          if (result.status === 'submitted' || result.status === 'already_submitted') {
            driven++;
          }
        }
      } catch (e) {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED,
          `contractId=${item.contract_id}`,
          `state=ready`,
          `reason=${formatErr(e)}`,
        );
      }
    }

    this.deps.audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      `migrated=${migration.migrated}`,
      `failed=${migration.failed}`,
      `recovered=${recovered}`,
      `driven=${driven}`,
    );

    return {
      migrated: migration.migrated,
      failed: migration.failed,
      recovered,
      driven,
    };
  }

  private async _buildPreparedRetroTask(
    item: RetrospectiveWorkItemV1,
    ctx: MotionReviewContext,
  ): Promise<PreparedSubagentSchedule> {
    const clawDir = path.join(ctx.clawsBaseDir, item.target_claw);
    const clawFs = ctx.clawFsFactory(clawDir);
    const clawContractManager = ctx.clawContractManagerFactory(clawDir, item.target_claw, clawFs);

    let contractYaml: string;
    try {
      contractYaml = await clawContractManager.readContractYamlRaw(item.contract_id);
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.YAML_FAILED,
        `contractId=${item.contract_id}`,
        `error=${formatErr(e)}`,
      );
      throw e;
    }

    // 2.3 加载 mining task messages（若 mining 模式，best-effort 退化）
    let baseMessages: Message[] = [];
    if (item.mode === 'mining' && item.mining_task_id) {
      const messagesPath = path.join('tasks', 'queues', 'results', item.mining_task_id, 'messages.json');
      try {
        const rawMining = await ctx.motionFs.read(messagesPath);
        const parsed = JSON.parse(rawMining);
        if (Array.isArray(parsed)) {
          baseMessages = parsed;
        }
      } catch (e) {
        if (!isFileNotFound(e)) {
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.MINING_FAILED,
            `contractId=${item.contract_id}`,
            `miningTaskId=${item.mining_task_id}`,
            `error=${formatErr(e)}`,
          );
        }
        // best-effort：加载失败退化为空上下文
      }
    }

    const payload = await buildRetroSubagentPayload({
      targetClaw: item.target_claw,
      contractId: item.contract_id,
      contractYaml,
      motionFs: ctx.motionFs,
      audit: this.deps.audit,
      baseMessages,
      retroSubagentTimeoutMs: this.deps.retroSubagentTimeoutMs,
      createSkillSystem: this.deps.createSkillSystem,
    });

    return {
      id: item.task_id as FullTaskId,
      createdAt: item.created_at,
      payload,
    };
  }

  private async _isContractCompleted(
    item: RetrospectiveWorkItemV1,
    ctx: MotionReviewContext,
  ): Promise<boolean> {
    const clawDir = path.join(ctx.clawsBaseDir, item.target_claw);
    const clawFs = ctx.clawFsFactory(clawDir);
    const clawContractManager = ctx.clawContractManagerFactory(clawDir, item.target_claw, clawFs);
    try {
      const progress = await clawContractManager.getProgress(item.contract_id);
      return !!progress?.completed_at;
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED,
        `contractId=${item.contract_id}`,
        `state=ready`,
        `reason=getProgress_failed`,
        `error=${formatErr(e)}`,
      );
      return false;
    }
  }
}
