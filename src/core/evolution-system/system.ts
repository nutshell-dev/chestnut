// src/core/evolution-system/system.ts
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AsyncTaskSystem } from '../async-task-system/index.js';
import { ContractSystem } from '../contract/index.js';
import { scheduleRetro } from './retro-scheduler.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
import * as path from 'path';

import { CLAWSPACE_DIR } from '../../foundation/paths.js';
import { CONTRACT_AUDIT_EVENTS } from '../contract/audit-events.js';
import type { Message } from '../../foundation/llm-provider/types.js';
import { FileNotFoundError } from '../../foundation/fs/types.js';
import { isProgrammingBug } from '../../foundation/errors.js';
import { readPendingRetrospective, InvalidJSONError, UnexpectedFormatError } from '../summon-system/index.js';
import type { ContractId } from '../contract/types.js';


export interface EvolutionSystemDeps {
  fs: FileSystem;
  audit: AuditLog;
  taskSystem: AsyncTaskSystem;
  contractManager: ContractSystem;
  retroSubagentTimeoutMs?: number;   // default 600000ms (10 min)
}

export interface RetroResult {
  status:
    | 'finished'
    | 'skipped_duplicate'
    | 'skipped_index_missing'
    | 'subagent_timeout'
    | 'no_skill_output'
    | 'error';
  detail?: string;
}

/** Motion 侧资源上下文（review_request 整合专用）。 */
export interface MotionReviewContext {
  /** Motion agent 根目录的 FileSystem（clawspace/pending-retrospective/by-contract/ 等资源的访问 fs） */
  motionFs: FileSystem;
  /** Motion agent 根目录绝对路径（NodeFileSystem.options.baseDir 同义，供 path.join 使用） */
  motionBaseDir: string;
  /** Motion audit sink（AsyncTaskSystem.schedule 调用需要）*/
  motionAudit: AuditLog;
  /** Claws 基础目录（解析目标 claw 路径：`path.resolve(clawsBaseDir, targetClaw)`）*/
  clawsBaseDir: string;
  /** 临时构建 target claw FileSystem 的 factory（assembly 注入 / 业务 0 触 L1 impl）*/
  clawFsFactory: (clawDir: string) => FileSystem;
  /** 临时构建 target claw ContractSystem 的 factory（assembly 注入 / 业务 0 触 L4 ctor）。
   *  factory 内部封装 createSystemAudit（避免 L2 audit instance leak 到业务）/ mirror phase 609 clawFsFactory 模板。 */
  clawContractManagerFactory: (clawDir: string, targetClaw: string, fs: FileSystem) => ContractSystem;
}

const STATE_FILE_PATH = '.evolution-system-state.json';   // motion root

interface EvolutionState {
  version: number;
  processedContractIds: string[];
  lastProcessedAt: string;
}

export class EvolutionSystem {
  private processedContractIds: Set<string> = new Set();
  private stateFileLoaded = false;
  private stateLoadPromise: Promise<void> | null = null;

  constructor(private readonly deps: EvolutionSystemDeps) {
  }

  /**
   * boot reconcile / lazy load 升 eager + audit emit trace
   * mirror phase 1285 InboxReader.init() 模板
   */
  async init(): Promise<void> {
    if (!this.stateFileLoaded) {
      this.stateLoadPromise ??= this._loadState();
      await this.stateLoadPromise;
      this.stateFileLoaded = true;
    }
    this.deps.audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      `processed_count=${this.processedContractIds.size}`,
      `recovered=${this.processedContractIds.size > 0}`,
    );
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
      if (
        typeof parsed !== 'object' || parsed === null ||
        !Array.isArray((parsed as { processedContractIds?: unknown }).processedContractIds) ||
        !((parsed as { processedContractIds: unknown[] }).processedContractIds).every((x: unknown) => typeof x === 'string')
      ) {
        await this._backupCorruptState(content, new Error('shape_mismatch'));
        return;
      }
      this.processedContractIds = new Set((parsed as { processedContractIds: string[] }).processedContractIds);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || e instanceof FileNotFoundError) {
        // first run / silent
        return;
      }
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED,
        `reason=${e instanceof Error ? e.message : String(e)}`,
      );
      // best-effort: 0 dedupe / 不抛
    }
  }

  private async _backupCorruptState(content: string, err: unknown): Promise<void> {
    this.processedContractIds = new Set();
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
    this.deps.audit.write(
      RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED,
      `backup=${backupPath}`,
      `move_ok=${moveOk}`,
      ...(moveOk ? [] : [`move_error=${moveErr instanceof Error ? moveErr.message : String(moveErr)}`]),
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
  }

  private async _saveState(): Promise<void> {
    try {
      const data: EvolutionState = {
        version: 1,
        processedContractIds: Array.from(this.processedContractIds),
        lastProcessedAt: new Date().toISOString(),
      };
      await this.deps.fs.writeAtomic(STATE_FILE_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.STATE_SAVE_FAILED,
        `reason=${e instanceof Error ? e.message : String(e)}`,
      );
      // best-effort: 不抛
    }
  }

  async start(): Promise<void> {
    // Subscribe to contract_completed event (Assembly wires this up via callback)
  }

  async stop(): Promise<void> {
    // Cleanup hooks
  }

  /** handleReviewRequest 6 步业务（phase411 Step B 物理迁自 ContractSystem） */
  async runRetroForContract(
    contractId: ContractId,
    ctx: MotionReviewContext,
  ): Promise<RetroResult> {
    // Step 0: lazy load state (first call only / atomic via Promise cache)
    if (!this.stateFileLoaded) {
      this.stateLoadPromise ??= this._loadState();
      await this.stateLoadPromise;
      this.stateFileLoaded = true;
    }

    // Step 1: dedupe check
    if (this.processedContractIds.has(contractId)) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.SKIPPED_DUPLICATE,
        `contractId=${contractId}`,
      );
      return { status: 'skipped_duplicate', detail: 'already processed' };
    }

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
      if (!r.targetClaw || !/^[a-z0-9-]+$/.test(r.targetClaw)) {
        this.deps.audit.write(RETRO_AUDIT_EVENTS.INDEX_FAILED, `contractId=${contractId}`, `reason=invalid_targetClaw`, `rawTarget=${r.targetClaw ?? 'null'}`);
        return { status: 'error', detail: 'invalid_targetClaw' };
      }
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
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || e instanceof FileNotFoundError) {
        return { status: 'skipped_index_missing', detail: 'ENOENT' };
      }
      this.deps.audit.write(RETRO_AUDIT_EVENTS.INDEX_FAILED, `contractId=${contractId}`, `error=${e instanceof Error ? e.message : String(e)}`);
      return { status: 'error', detail: code };
    }

    // Part 2: contract YAML + skills + mining messages（daemon.ts:160-213 等价）

    // 2.1 加载契约 YAML（factory 注入 target claw ContractSystem / phase 619 caller-DIP enforce）
    const clawDir = path.join(ctx.clawsBaseDir, targetClaw);
    const clawFs = ctx.clawFsFactory(clawDir);
    const clawContractManager = ctx.clawContractManagerFactory(clawDir, targetClaw, clawFs);

    let contractYaml: string;
    try {
      contractYaml = await clawContractManager.readContractYamlRaw(contractId);
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.YAML_FAILED,
        `contractId=${contractId}`,
        `error=${e instanceof Error ? e.message : String(e)}`,
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
        }
      } catch (e) {
        const isMissing =
          (e as NodeJS.ErrnoException).code === 'ENOENT' ||
          e instanceof FileNotFoundError;
        if (isMissing) {
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.MINING_FAILED,
            `taskId=${miningTaskId}`,
            'reason=ENOENT',
          );
        } else {
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.MINING_FAILED,
            `taskId=${miningTaskId}`,
            `error=${e instanceof Error ? e.message : String(e)}`,
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
      });
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.SCHEDULE_FAILED,
        `error=${e instanceof Error ? e.message : String(e)}`,
      );
      return { status: 'error', detail: 'schedule_failed' };
    }

    // 3.3 调度成功后 cleanup by-contract 索引（best-effort）
    await ctx.motionFs.delete(byContractPath).catch(e => {
      // phase384/B.p347-retro-8: 区分编程 bug vs 业务 throw / 编程 bug 暴露 audit
      if (isProgrammingBug(e)) {
        this.deps.audit.write(
          CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW,
          `context=EvolutionSystem.retroIndexCleanup`,
          `errorType=${e instanceof Error ? e.constructor.name : typeof e}`,
          `error=${e instanceof Error ? e.message : String(e)}`,
          `stack=${e instanceof Error ? e.stack ?? '' : ''}`,
        );
      }
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.CLEANUP_FAILED,
        `error=${e instanceof Error ? e.message : String(e)}`,
      );
    });

    // Step Final: push contractId to dedupe set + save state (best-effort)
    this.processedContractIds.add(contractId);
    await this._saveState();

    return { status: 'finished' };
  }
}
