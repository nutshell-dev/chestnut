// src/core/evolution-system/system.ts
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { PreparedSubAgentTaskScheduler } from '../async-task-system/index.js';
import { ContractSystem } from '../contract/index.js';
import { createSkillSystem as defaultCreateSkillSystem } from '../../foundation/skill-system/index.js';
import { buildRetroSubagentPayload } from './retro-scheduler.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
import * as path from 'path';

import { type ContractId } from '../contract/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import type { LegacyPendingRetrospective } from './retrospective-store.js';
import type { FullTaskId, PreparedSubagentSchedule } from '../async-task-system/index.js';
import {
  RetrospectiveStore,
  executorIdOf,
  type RetrospectiveWorkItem,
} from './retrospective-store.js';

interface EvolutionSystemDeps {
  fs: FileSystem;
  audit: AuditLog;
  taskSystem: PreparedSubAgentTaskScheduler;
  contractManager: ContractSystem;
  retroSubagentTimeoutMs?: number;   // default 600000ms (10 min)
  createSkillSystem?: typeof defaultCreateSkillSystem;
  /**
   * phase 1445 Step D（裁定②）：boot reconcile（init）内化进 createEvolutionSystem 工厂，
   *  ctx 经工厂参数传入（原 Assembly 直调 evolutionSystem.init(ctx) 已删）。
   */
  motionReviewContext: MotionReviewContext;
}

interface RetroResult {
  status:
    | 'submitted'
    | 'already_submitted'
    | 'already_dispatching'
    | 'missing_work_item'
    | 'error';
  detail?: string;
  taskId?: string;
  reason?: string;
}

/**
 * Phase 1396 Step M: 跨模块传递的已完成契约稳定身份。
 * completedAt / archive path / observer cursor / summon source 都不跨边界。
 */
export interface CompletedContractRef {
  contractId: ContractId;
  executorId: ClawId;
}

/** Motion 侧资源（pending-retrospective 索引读取 + motion audit 路由）。 */
interface MotionResources {
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
interface ClawFactories {
  /** 临时构建 target claw FileSystem 的 factory（assembly 注入 / 业务 0 触 L1 impl）*/
  clawFsFactory: (clawDir: string) => FileSystem;
  /** 临时构建 target claw ContractSystem 的 factory（assembly 注入 / 业务 0 触 L4 ctor）。
   *  factory 内部封装 createSystemAudit（避免 L2 audit instance leak 到业务）。
   *  phase 1445 Step D：createContractSystem 工厂变 async（bootReconcile opt-in），
   *  本 factory 随之 async；旁路实例故意不传 bootReconcile（不 init、只读用途）。 */
  clawContractManagerFactory: (clawDir: string, targetClaw: string, fs: FileSystem) => Promise<ContractSystem>;
}

/** Context for retrospective review: motion resources + claw factories. */
export interface MotionReviewContext extends MotionResources, ClawFactories {
  /**
   * Phase 1206 Step D: legacy pending-retrospective migration callbacks.
   * EvolutionSystem delegates migration to RetrospectiveStore but does not
   * import the legacy read/ack surface directly (architecture ratchet).
   */
  listLegacyPendingRetrospectives?: () => Promise<LegacyPendingRetrospective[]>;
  ackLegacyPendingRetrospective?: (contractId: ContractId) => Promise<void>;
}

const LEGACY_STATE_FILE_PATH = '.evolution-system-state.json';

export class EvolutionSystem {
  private readonly store: RetrospectiveStore;

  constructor(private readonly deps: EvolutionSystemDeps) {
    this.store = new RetrospectiveStore({ fs: deps.fs, audit: deps.audit });
  }

  /**
   * Phase 1396 Step M: contract completed 事实入口（ContractObserver 经 Assembly 喂入）。
   * EvolutionSystem 先幂等提交 v2 work item，再 acquire/dispatch；重复观察由
   * durable row 吸收。注册/派发失败保留 durable 状态，由 recoverRetrospectives 恢复。
   */
  async observeContractCompleted(
    ref: CompletedContractRef,
    ctx: MotionReviewContext,
  ): Promise<RetroResult> {
    // 1. 先幂等提交 v2 work item —— 只有落盘成功后才允许推进 observer 水位。
    try {
      await this.store.ensure({
        contractId: ref.contractId,
        targetExecutorId: ref.executorId,
      });
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED,
        `contractId=${ref.contractId}`,
        `state=observe`,
        `reason=${formatErr(e)}`,
      );
      return { status: 'error', detail: formatErr(e) };
    }

    // 2. acquire dispatch authority；'busy' = 上次崩于 dispatching（或并发在飞）——
    //    原地重投同一 durable row（task_id 稳定、幂等），使 observer 重试同 boot 内收敛。
    const disposition = await this.store.beginDispatch(ref.contractId);
    if (disposition === 'submitted') return { status: 'already_submitted' };
    if (disposition === 'missing') {
      // ensure 刚写成功却读不到：防御分支，audit 可观察。
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
        `contractId=${ref.contractId}`,
        `state=ready`,
        `reason=row_disappeared_after_ensure`,
      );
      return { status: 'error', detail: 'work_item_lost_after_ensure' };
    }

    const item = await this.store.readDispatching(ref.contractId);
    if (!item) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
        `contractId=${ref.contractId}`,
        `state=dispatching`,
        `reason=row_disappeared_after_acquire`,
      );
      return { status: 'error', detail: 'dispatching_row_lost' };
    }

    try {
      return await this.submitDispatching(item, ctx);
    } catch (e) {
      // 派发失败：row 保留在 dispatching，由 observer 重试或 boot recovery 恢复。
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED,
        `contractId=${ref.contractId}`,
        `state=dispatching`,
        `reason=${formatErr(e)}`,
      );
      return { status: 'error', detail: formatErr(e) };
    }
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

    return this.submitDispatching(item, ctx);
  }

  /**
   * Single path for submitting a dispatching row. Keeps the row in dispatching
   * on schedule/markSubmitted failure so recovery can retry.
   */
  private async submitDispatching(
    item: RetrospectiveWorkItem,
    ctx: MotionReviewContext,
  ): Promise<RetroResult> {
    const prepared = await this._buildPreparedRetroTask(item, ctx);
    const scheduled = await this.deps.taskSystem.schedulePrepared('subagent', prepared);
    await this.store.markSubmitted(item.contract_id);
    return { status: 'submitted', taskId: scheduled.taskId };
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
      ctx.listLegacyPendingRetrospectives ?? (() => Promise.resolve([])),
      ctx.ackLegacyPendingRetrospective ?? (() => Promise.resolve()),
    );

    let recovered = 0;
    let failed = migration.failed;
    const dispatching = await this.store.listDispatching();
    for (const item of dispatching) {
      try {
        const result = await this.submitDispatching(item, ctx);
        if (result.status === 'submitted' || result.status === 'already_submitted') {
          recovered++;
        } else {
          failed++;
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED,
            `contractId=${item.contract_id}`,
            `state=dispatching`,
            `reason=${result.status}`,
            `detail=${result.detail ?? ''}`,
          );
        }
      } catch (e) {
        failed++;
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
          } else {
            failed++;
            this.deps.audit.write(
              RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED,
              `contractId=${item.contract_id}`,
              `state=ready`,
              `reason=${result.status}`,
              `detail=${result.detail ?? ''}`,
            );
          }
        }
      } catch (e) {
        failed++;
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
      `failed=${failed}`,
      `recovered=${recovered}`,
      `driven=${driven}`,
    );

    return {
      migrated: migration.migrated,
      failed,
      recovered,
      driven,
    };
  }

  private async _buildPreparedRetroTask(
    item: RetrospectiveWorkItem,
    ctx: MotionReviewContext,
  ): Promise<PreparedSubagentSchedule> {
    // Phase 1396 Step M: retro task payload 只用 target executor + contract YAML；
    // v1 的 mining/shadow source task id 无行为消费者，v2 已不保存。
    const executorId = executorIdOf(item);
    const clawDir = path.join(ctx.clawsBaseDir, executorId);
    const clawFs = ctx.clawFsFactory(clawDir);
    const clawContractManager = await ctx.clawContractManagerFactory(clawDir, executorId, clawFs);

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

    const payload = await buildRetroSubagentPayload({
      targetClaw: executorId,
      contractId: item.contract_id,
      contractYaml,
      motionFs: ctx.motionFs,
      audit: this.deps.audit,
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
    item: RetrospectiveWorkItem,
    ctx: MotionReviewContext,
  ): Promise<boolean> {
    const executorId = executorIdOf(item);
    const clawDir = path.join(ctx.clawsBaseDir, executorId);
    const clawFs = ctx.clawFsFactory(clawDir);
    const clawContractManager = await ctx.clawContractManagerFactory(clawDir, executorId, clawFs);
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


/**
 * phase 1445 Step D（裁定②）：init(ctx) 内化进工厂 —— 构造后工厂内 await init
 * （boot reconcile：legacy 观察 + retrospective 恢复）；init 失败原样冒泡。调用方一律 await。
 */
export async function createEvolutionSystem(deps: EvolutionSystemDeps): Promise<EvolutionSystem> {
  const system = new EvolutionSystem(deps);
  await system.init(deps.motionReviewContext);
  return system;
}
