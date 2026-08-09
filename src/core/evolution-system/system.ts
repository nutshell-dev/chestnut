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
import type { RegisterRetrospectiveInput, LegacyPendingRetrospective } from './retrospective-store.js';
import type { FullTaskId, PreparedSubagentSchedule } from '../async-task-system/index.js';
import {
  RetrospectiveStore,
  type RetrospectiveWorkItemV1,
} from './retrospective-store.js';

export interface EvolutionSystemDeps {
  fs: FileSystem;
  audit: AuditLog;
  taskSystem: PreparedSubAgentTaskScheduler;
  contractManager: ContractSystem;
  retroSubagentTimeoutMs?: number;   // default 600000ms (10 min)
  createSkillSystem?: typeof defaultCreateSkillSystem;
}

export interface RetroResult {
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
   * Phase 1206 Step D: public durable registration surface.
   * Callers (e.g. summon post-processor) register a retrospective work item
   * without knowing the disk layout. Success/failure only; the store owns ids.
   */
  async registerRetrospective(input: RegisterRetrospectiveInput): Promise<void> {
    await this.store.register(input);
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
    item: RetrospectiveWorkItemV1,
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

    const payload = await buildRetroSubagentPayload({
      targetClaw: item.target_claw,
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


export function createEvolutionSystem(deps: EvolutionSystemDeps): EvolutionSystem {
  return new EvolutionSystem(deps);
}
