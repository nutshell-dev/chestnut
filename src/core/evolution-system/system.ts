// src/core/evolution-system/system.ts
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AsyncTaskSystem } from '../async-task-system/index.js';
import { ContractSystem } from '../contract/index.js';
import { createSkillSystem as defaultCreateSkillSystem } from '../../foundation/skill-system/index.js';
import { scheduleRetro } from './retro-scheduler.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
import { assertEvolutionStateShape } from './invariants.js';
import * as path from 'path';

import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../contract/index.js';
import type { Message } from '../../foundation/llm-provider/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
const PROGRAMMING_BUG_TYPES = [TypeError, ReferenceError, SyntaxError, RangeError] as const;
import { readPendingRetrospective, InvalidJSONError, UnexpectedFormatError, InvalidTargetClawError } from '../summon-system/index.js';
import type { ContractId } from '../contract/types.js';


export interface EvolutionSystemDeps {
  fs: FileSystem;
  audit: AuditLog;
  taskSystem: AsyncTaskSystem;
  contractManager: ContractSystem;
  retroSubagentTimeoutMs?: number;   // default 600000ms (10 min)
  createSkillSystem?: typeof defaultCreateSkillSystem;
}

// phase 450 (review-round3 §3): retroChain wait prev 超时上限（10 min）
// 推导：与 retroSubagentTimeoutMs 默认对齐（一个 subagent 最长生命周期）；
// chain 卡死多因 prev subagent 自身超时未抛错、等同 stall 信号。
const RETRO_CHAIN_STALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface RetroResult {
  status:
    | 'finished'
    | 'skipped_duplicate'
    | 'skipped_index_missing'
    | 'skipped_missing_completed_at'  // phase 324 C5
    | 'error';
  detail?: string;
}

/** Motion 侧资源（pending-retrospective 索引读取 + motion audit 路由）。
 *  motionAudit 与 EvolutionSystemDeps.audit（claw 侧）是两个独立 audit routing target，
 *  分别写到 motion sink 与 claw sink，不可合并。 */
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

/** 调用方便组合：runRetroForContract 一次性收到 motion 资源 + claw factory 两组语义。
 *  内部仍以 MotionResources / ClawFactories 区分关注点（I 接口隔离）。 */
export interface MotionReviewContext extends MotionResources, ClawFactories {}

const STATE_FILE_PATH = '.evolution-system-state.json';   // motion root

interface EvolutionState {
  version: number;
  lastProcessedAt: number;   // ms epoch 高水位线
}

export class EvolutionSystem {
  private state: EvolutionState = { version: 1, lastProcessedAt: 0 };
  private stateFileLoaded = false;
  private stateLoadPromise: Promise<void> | null = null;
  // phase 406 Step B (review N7): serialize concurrent runRetroForContract
  // calls via instance promise chain — concurrent contract completions both
  // read/write state.lastProcessedAt; without this guard the HWM (high water
  // mark) silently downgrades and dedupe drifts. Same pattern as
  // foundation/messaging/SequenceCounter.next().
  private retroChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: EvolutionSystemDeps) {
  }

  /**
   * boot reconcile / lazy load 升 eager + audit emit trace
   * mirror phase 1285 InboxReader.init() 模板
   */
  async init(): Promise<void> {
    await this._ensureStateLoaded();
    this.deps.audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      `last_processed_at=${this.state.lastProcessedAt}`,
      `high_water_mark_mode=true`,
    );
  }

  private async _ensureStateLoaded(): Promise<void> {
    if (this.stateFileLoaded) return;
    this.stateLoadPromise ??= this._loadState();
    try {
      await this.stateLoadPromise;
      this.stateFileLoaded = true;
    } catch {
      // _loadState 已 audit；重置缓存允许下次重试，stateFileLoaded 保持 false
      this.stateLoadPromise = null;
    }
  }

  private async _loadState(): Promise<void> {
    try {
      const content = await this.deps.fs.read(STATE_FILE_PATH);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (parseErr) {
        await this._backupCorruptState(content, parseErr);
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        await this._backupCorruptState(content, new Error('shape_mismatch'));
        return;
      }
      const r = parsed as Record<string, unknown>;

      // phase 280: legacy schema migration (option 2 silent reset + audit emit)
      if ('processedContractIds' in r) {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_SCHEMA_MIGRATED_RESET,
          `legacy_field=processedContractIds`,
          `legacy_count=${Array.isArray(r.processedContractIds) ? r.processedContractIds.length : 0}`,
        );
        this.state = { version: 1, lastProcessedAt: 0 };
        return;
      }

      // 新 schema validation
      if (typeof r.version !== 'number' || typeof r.lastProcessedAt !== 'number'
          || !Number.isFinite(r.lastProcessedAt) || r.lastProcessedAt < 0) {
        await this._backupCorruptState(content, new Error('shape_mismatch'));
        return;
      }
      this.state = { version: r.version, lastProcessedAt: r.lastProcessedAt };
    } catch (e) {
      if (isFileNotFound(e)) {
        // first run / silent（helper 内含 instanceof FileNotFoundError check）
        return;
      }
      // phase 709: 加 path col、与 phase 580/586/684/685/688 path forensic 形态对齐
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED,
        `path=${STATE_FILE_PATH}`,
        `reason=${formatErr(e)}`,
      );
      throw e; // 由 _ensureStateLoaded 决定 sticky vs retry
    }
  }

  private async _backupCorruptState(content: string, err: unknown): Promise<void> {
    this.state = { version: 1, lastProcessedAt: 0 };
    const backupPath = `${STATE_FILE_PATH}.corrupt-${Date.now()}`;
    let moveOk = true;
    let moveErr: unknown = undefined;
    try {
      await this.deps.fs.writeAtomic(backupPath, content);
      await this.deps.fs.delete(STATE_FILE_PATH);
    } catch (mErr) {
      moveOk = false;
      moveErr = mErr;
    }
    // phase 709: 加 path col、与上一 site 形态一致
    this.deps.audit.write(
      RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED,
      `path=${STATE_FILE_PATH}`,
      `backup=${backupPath}`,
      `move_ok=${moveOk}`,
      ...(moveOk ? [] : [`move_error=${formatErr(moveErr)}`]),
      `reason=${formatErr(err)}`,
    );
  }

  private async _saveState(): Promise<void> {
    try {
      // phase 253 Step A: schema invariant check（phase 280 更新为高水位线字段）
      assertEvolutionStateShape(this.state, this.deps.audit);

      await this.deps.fs.writeAtomic(STATE_FILE_PATH, JSON.stringify(this.state, null, 2));
    } catch (e) {
      // phase 710: 加 path col、与 phase 709 STATE_LOAD_FAILED 同模块同 file path 形态对齐
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.STATE_SAVE_FAILED,
        `path=${STATE_FILE_PATH}`,
        `reason=${formatErr(e)}`,
      );
      // best-effort: 不抛
    }
  }

  /** handleReviewRequest 6 步业务（phase411 Step B 物理迁自 ContractSystem） */
  async runRetroForContract(
    contractId: ContractId,
    ctx: MotionReviewContext,
  ): Promise<RetroResult> {
    // phase 406 Step B (review N7): mutex serialize、防 HWM race
    // phase 450 (review-round3 §3): wait prev 加 stall timeout、超时不让 chain 永久阻塞下游
    const prev = this.retroChain;
    const p = (async (): Promise<RetroResult> => {
      let stalled = false;
      await Promise.race([
        prev.catch(() => undefined),  // 既有 chain-only swallow 保留
        new Promise<void>(resolve => {
          const t = setTimeout(() => {
            stalled = true;
            resolve();
          }, RETRO_CHAIN_STALL_TIMEOUT_MS);
          t.unref?.();  // 防 timer 阻塞 Node 退出
        }),
      ]);
      if (stalled) {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_CHAIN_STALLED,
          `contract_id=${contractId}`,
          `timeout_ms=${RETRO_CHAIN_STALL_TIMEOUT_MS}`,
        );
      }
      return this._runRetroForContractImpl(contractId, ctx);
    })();
    this.retroChain = p;
    return p;
  }

  private async _runRetroForContractImpl(
    contractId: ContractId,
    ctx: MotionReviewContext,
  ): Promise<RetroResult> {
    // Step 0: lazy load state (first call only / retry on failure)
    await this._ensureStateLoaded();

    // Part 1: by-contract 索引解析（phase 1335: cross-module query API 替代直读）
    const byContractPath = path.join(
      CLAWSPACE_DIR, 'pending-retrospective', 'by-contract',
      `${contractId}.json`,
    );

    let targetClaw: string | null = null;
    let mode: string | undefined;
    let miningTaskId: string | undefined;
    try {
      const r = await readPendingRetrospective({ fs: ctx.motionFs, contractId });
      targetClaw = r.targetClaw;
      mode = r.mode;
      miningTaskId = r.miningTaskId;
    } catch (e) {
      if (e instanceof InvalidJSONError) {
        this.deps.audit.write(RETRO_AUDIT_EVENTS.INDEX_FAILED, `contractId=${contractId}`, `reason=invalid_json`);
        return { status: 'error', detail: 'invalid_json' };
      }
      if (e instanceof UnexpectedFormatError) {
        this.deps.audit.write(RETRO_AUDIT_EVENTS.INDEX_FAILED, `contractId=${contractId}`, `reason=unexpected_format`);
        return { status: 'error', detail: 'unexpected_format' };
      }
      if (e instanceof InvalidTargetClawError) {
        this.deps.audit.write(RETRO_AUDIT_EVENTS.INDEX_FAILED, `contractId=${contractId}`, `reason=invalid_targetClaw`, `rawTarget=${e.raw}`);
        return { status: 'error', detail: 'invalid_targetClaw' };
      }
      if (isFileNotFound(e)) {
        return { status: 'skipped_index_missing', detail: 'ENOENT' };
      }
      const code = (e as NodeJS.ErrnoException).code;
      this.deps.audit.write(RETRO_AUDIT_EVENTS.INDEX_FAILED, `contractId=${contractId}`, `error=${formatErr(e)}`);
      return { status: 'error', detail: code };
    }

    // Part 2: contract YAML + skills + mining messages（daemon.ts:160-213 等价）

    // 2.1 加载契约 YAML（factory 注入 target claw ContractSystem / phase 619 caller-DIP enforce）
    const clawDir = path.join(ctx.clawsBaseDir, targetClaw);
    const clawFs = ctx.clawFsFactory(clawDir);
    const clawContractManager = ctx.clawContractManagerFactory(clawDir, targetClaw, clawFs);

    // phase 280: 高水位线 dedupe（替代 processedContractIds Set）
    // phase 324 C5: progress.completed_at 缺失时不再 fallback Date.now()
    // —— 旧码会把高水位推到当前时间、屏蔽所有真正较老的 contract、retro 处理永久禁。
    // 改返 skipped_missing_completed_at、不推水位、写 audit。
    let contractArchivedAtMs: number;
    try {
      const progress = await clawContractManager.getProgress(contractId);
      if (!progress?.completed_at) {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.EVOLUTION_SKIPPED_MISSING_COMPLETED_AT,
          `contractId=${contractId}`,
          `reason=progress_completed_at_missing`,
        );
        return { status: 'skipped_missing_completed_at', detail: 'progress.completed_at missing — refusing to advance watermark' };
      }
      contractArchivedAtMs = new Date(progress.completed_at).getTime();
      if (!Number.isFinite(contractArchivedAtMs)) {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.EVOLUTION_SKIPPED_MISSING_COMPLETED_AT,
          `contractId=${contractId}`,
          `reason=progress_completed_at_unparseable`,
          `raw=${progress.completed_at}`,
        );
        return { status: 'skipped_missing_completed_at', detail: 'progress.completed_at unparseable — refusing to advance watermark' };
      }
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.INDEX_FAILED,
        `contractId=${contractId}`,
        `reason=getProgress_failed`,
        `error=${formatErr(e)}`,
      );
      return { status: 'error', detail: 'get_progress_failed' };
    }

    if (contractArchivedAtMs <= this.state.lastProcessedAt) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.SKIPPED_DUPLICATE,
        `contractId=${contractId}`,
        `reason=before_high_water_mark`,
      );
      return { status: 'skipped_duplicate', detail: 'already processed' };
    }

    let contractYaml: string;
    try {
      contractYaml = await clawContractManager.readContractYamlRaw(contractId);
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.YAML_FAILED,
        `contractId=${contractId}`,
        `error=${formatErr(e)}`,
      );
      return { status: 'error', detail: 'yaml_failed' };
    }

    // 2.3 加载 mining task messages（若 mining 模式，2 best-effort 退化）
    let baseMessages: Message[] = [];
    if (mode === 'mining' && miningTaskId) {
      const messagesPath = path.join('tasks', 'queues', 'results', miningTaskId, 'messages.json');
      try {
        const rawMining = await ctx.motionFs.read(messagesPath);
        const parsed = JSON.parse(rawMining);
        if (Array.isArray(parsed)) {
          baseMessages = parsed;
        } else {
          // phase 430 Step C (review medium): shape mismatch 静默 degrade 修复
          // — 之前 silent fallthrough、baseMessages 保持空、无 forensics
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.MINING_FAILED,
            `taskId=${miningTaskId}`,
            'reason=shape_mismatch',
            `actual_type=${typeof parsed === 'object' && parsed !== null ? (Array.isArray(parsed) ? 'array' : 'object') : typeof parsed}`,
          );
        }
      } catch (e) {
        if (isFileNotFound(e)) {
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.MINING_FAILED,
            `taskId=${miningTaskId}`,
            'reason=ENOENT',
          );
        } else {
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.MINING_FAILED,
            `taskId=${miningTaskId}`,
            `error=${formatErr(e)}`,
          );
        }
        // best-effort：加载失败退化为空上下文
      }
    }

    // Part 3: retro scheduling via scheduleRetro standalone function（phase426 推翻 port 抽象）
    try {
      await scheduleRetro({
        targetClaw,
        contractId,
        contractYaml,
        motionFs: ctx.motionFs,
        motionAudit: ctx.motionAudit,
        motionBaseDir: ctx.motionBaseDir,
        baseMessages,
        audit: this.deps.audit,
        retroSubagentTimeoutMs: this.deps.retroSubagentTimeoutMs,
        taskSystem: this.deps.taskSystem,
        createSkillSystem: this.deps.createSkillSystem,
      });
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.SCHEDULE_FAILED,
        `error=${formatErr(e)}`,
      );
      return { status: 'error', detail: 'schedule_failed' };
    }

    // 3.3 调度成功后 cleanup by-contract 索引（best-effort）
    await ctx.motionFs.delete(byContractPath).catch(e => {
      // phase384/B.p347-retro-8: 区分编程 bug vs 业务 throw / 编程 bug 暴露 audit
      if (PROGRAMMING_BUG_TYPES.some(T => e instanceof T)) {
        this.deps.audit.write(
          CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW,
          `context=EvolutionSystem.retroIndexCleanup`,
          `errorType=${e instanceof Error ? e.constructor.name : typeof e}`,
          `error=${formatErr(e)}`,
          `stack=${e instanceof Error ? e.stack ?? '' : ''}`,
        );
      }
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.CLEANUP_FAILED,
        `error=${formatErr(e)}`,
      );
    });

    // Step Final: 更新高水位线 + save state (best-effort)
    this.state.lastProcessedAt = Math.max(this.state.lastProcessedAt, contractArchivedAtMs);
    await this._saveState();

    return { status: 'finished' };
  }
}
