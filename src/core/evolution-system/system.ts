// src/core/evolution-system/system.ts
import type { AuditLog, AuditWriter } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { TaskSystem } from '../task/index.js';
import { ContractManager } from '../contract/manager.js';
import type { SkillRegistry } from '../skill/index.js';
import type { RetroScheduler } from './retro-scheduler.js';
import { createDefaultRetroScheduler } from './retro-scheduler.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
import * as path from 'path';
import * as fsAsync from 'fs/promises';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { CLAWSPACE_DIR } from '../../types/paths.js';
import { CONTRACT_AUDIT_EVENTS } from '../contract/audit-events.js';
import type { Message } from '../../types/message.js';

export interface EvolutionSystemDeps {
  fs: FileSystem;
  audit: AuditLog;
  taskSystem: TaskSystem;
  contractManager: ContractManager;
  skillRegistry?: SkillRegistry;   // for SkillSystem.reload coordination
  retroScheduler?: RetroScheduler;  // optional override / default = createDefaultRetroScheduler
}

export interface RetroResult {
  status: 'finished' | 'skipped_duplicate' | 'subagent_timeout' | 'no_skill_output' | 'reload_failed' | 'error';
  detail?: string;
}

export class EvolutionError extends Error {
  readonly code: 'reload_failed' | 'unknown';
  constructor(code: 'reload_failed' | 'unknown', message?: string) {
    super(message);
    this.code = code;
    this.name = 'EvolutionError';
  }
}

/** Motion 侧资源上下文（review_request 整合专用）。 */
export interface MotionReviewContext {
  /** Motion agent 根目录的 FileSystem（clawspace/pending-retrospective/by-contract/ 等资源的访问 fs） */
  motionFs: FileSystem;
  /** Motion agent 根目录绝对路径（NodeFileSystem.options.baseDir 同义，供 path.join 使用） */
  motionBaseDir: string;
  /** Motion audit sink（writePendingSubagentTaskFile 调用需要）*/
  motionAudit: AuditWriter;
  /** Claws 基础目录（解析目标 claw 路径：`path.resolve(clawsBaseDir, targetClaw)`）*/
  clawsBaseDir: string;
}

// Programming bug detection (per Coding #5 / phase342 / r40 反向 3 教训)
const PROGRAMMING_BUG_TYPES = [TypeError, ReferenceError, SyntaxError, RangeError];
function isProgrammingBug(err: unknown): boolean {
  return PROGRAMMING_BUG_TYPES.some(T => err instanceof T);
}

export class EvolutionSystem {
  private readonly retroScheduler: RetroScheduler;

  constructor(private readonly deps: EvolutionSystemDeps) {
    this.retroScheduler = deps.retroScheduler ?? createDefaultRetroScheduler();
  }

  async start(): Promise<void> {
    // Subscribe to contract_completed event (Assembly wires this up via callback)
  }

  async stop(): Promise<void> {
    // Cleanup hooks
  }

  /** handleReviewRequest 6 步业务（phase411 Step B 物理迁自 ContractManager） */
  async runRetroForContract(
    contractId: string,
    ctx: MotionReviewContext,
  ): Promise<RetroResult> {
    // Part 1: by-contract 索引解析（daemon.ts:124-158 等价迁移）
    const byContractPath = path.join(
      ctx.motionBaseDir,
      CLAWSPACE_DIR, 'pending-retrospective', 'by-contract',
      `${contractId}.json`,
    );

    let targetClaw: string | null = null;
    let mode: string | undefined;
    let miningTaskId: string | undefined;
    try {
      const fileContent = await fsAsync.readFile(byContractPath, 'utf-8');
      let raw: unknown;
      try {
        raw = JSON.parse(fileContent);
      } catch {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.INDEX_FAILED,
          `contractId=${contractId}`,
          'reason=invalid_json',
        );
        return { status: 'error', detail: 'invalid_json' };
      }
      if (typeof raw !== 'object' || raw === null) {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.INDEX_FAILED,
          `contractId=${contractId}`,
          'reason=unexpected_format',
        );
        return { status: 'error', detail: 'unexpected_format' };
      }
      const r = raw as Record<string, unknown>;
      const rawTarget = typeof r.targetClaw === 'string' ? r.targetClaw : null;
      if (!rawTarget || !/^[a-z0-9-]+$/.test(rawTarget)) {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.INDEX_FAILED,
          `contractId=${contractId}`,
          `reason=invalid_targetClaw`,
          `rawTarget=${rawTarget ?? 'null'}`,
        );
        return { status: 'error', detail: 'invalid_targetClaw' };
      }
      targetClaw = rawTarget;
      // Part 1 回填：mode / miningTaskId（Step 3 预留，Step 4 回填）
      mode = typeof r.mode === 'string' ? r.mode : undefined;
      miningTaskId = typeof r.miningTaskId === 'string' ? r.miningTaskId : undefined;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.deps.audit.write(
          RETRO_AUDIT_EVENTS.INDEX_FAILED,
          `contractId=${contractId}`,
          `err=${e instanceof Error ? e.message : String(e)}`,
        );
        return { status: 'error', detail: code };
      }
      return { status: 'skipped_duplicate', detail: 'ENOENT' };
    }

    // Part 2: contract YAML + skills + mining messages（daemon.ts:160-213 等价）

    // 2.1 加载契约 YAML（临时 new ContractManager for target claw，B.p175-2 登记）
    const clawDir = path.join(ctx.clawsBaseDir, targetClaw);
    const clawFs = new NodeFileSystem({ baseDir: clawDir });
    const clawContractManager = new ContractManager(clawDir, targetClaw, clawFs, createSystemAudit(clawFs, clawDir));

    let contractYaml: string;
    try {
      contractYaml = await clawContractManager.readContractYamlRaw(contractId);
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.YAML_FAILED,
        `contractId=${contractId}`,
        `err=${e instanceof Error ? e.message : String(e)}`,
      );
      return { status: 'error', detail: 'yaml_failed' };
    }

    // 2.3 加载 mining task messages（若 mining 模式，2 best-effort 退化）
    let baseMessages: Message[] = [];
    if (mode === 'mining' && miningTaskId) {
      const messagesPath = path.join(ctx.motionBaseDir, 'tasks', 'results', miningTaskId, 'messages.json');
      try {
        const rawMining = await fsAsync.readFile(messagesPath, 'utf-8');
        const parsed = JSON.parse(rawMining);
        if (Array.isArray(parsed)) {
          baseMessages = parsed;
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.MINING_FAILED,
            `taskId=${miningTaskId}`,
            'reason=ENOENT',
          );
        } else {
          this.deps.audit.write(
            RETRO_AUDIT_EVENTS.MINING_FAILED,
            `taskId=${miningTaskId}`,
            `err=${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // best-effort：加载失败退化为空上下文
      }
    }

    // Part 3: retro scheduling via RetroScheduler port（A.3+A.4+A.5 / phase364）
    try {
      await this.retroScheduler.schedule({
        targetClaw,
        contractId,
        contractYaml,
        motionFs: ctx.motionFs,
        motionAudit: ctx.motionAudit,
        motionBaseDir: ctx.motionBaseDir,
        baseMessages,
        audit: this.deps.audit,
      });
    } catch (e) {
      this.deps.audit.write(
        RETRO_AUDIT_EVENTS.SCHEDULE_FAILED,
        `err=${e instanceof Error ? e.message : String(e)}`,
      );
      return { status: 'error', detail: 'schedule_failed' };
    }

    // 3.3 调度成功后 cleanup by-contract 索引（best-effort）
    await fsAsync.unlink(byContractPath).catch(e => {
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
        `err=${e instanceof Error ? e.message : String(e)}`,
      );
    });

    return { status: 'finished' };
  }
}
