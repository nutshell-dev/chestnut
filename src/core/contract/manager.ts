/**
 * ContractManager - Contract lifecycle management
 *
 * Manages contract loading, progress tracking, acceptance, and status transitions.
 */

import * as yaml from 'js-yaml';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fsNative from 'fs';
import * as fsAsync from 'fs/promises';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMService } from '../../foundation/llm/index.js';
import type { Contract, SubTask, ContractStatus, SubtaskStatus } from '../../types/contract.js';
import { ToolError, ToolTimeoutError } from '../../types/errors.js';
import { exec, execFile } from '../../foundation/process-exec/index.js';
import { ProcessExecError } from '../../foundation/process-exec/index.js';
import { LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_STALE_TIMEOUT_MS, CONTRACT_SCRIPT_TIMEOUT_MS, DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_MAX_STEPS } from '../../constants.js';
import { CONTRACT_VERIFIER_SYSTEM_PROMPT } from '../../prompts/subagent.js';
import { InboxWriter } from '../../foundation/messaging/index.js';
import { ToolRegistryImpl } from '../tools/registry.js';
import { buildRetroPrompt } from '../../prompts/retrospective.js';
import { writePendingSubagentTaskFile } from '../task/tools/_pending-task-writer.js';
import type { ContractVerifierScheduler } from './verifier-scheduler.js';
import { createSubAgentVerifierScheduler } from './verifier-scheduler.js';
import { AuditWriter } from '../../foundation/audit/writer.js';
import type { Message } from '../../types/message.js';
import { createSkillRegistry } from '../skill/index.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';


/**
 * Motion 侧资源上下文（review_request 整合专用）。
 * 由 Daemon 调用 handleReviewRequest 时注入；ContractManager 不管 motion 上下文生命周期。
 */
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


// Contract default value constants
const CONTRACT_DEFAULTS = {
  schema_version: 1,
  auth_level: 'auto' as const,
};

// YAML contract file structure (exported for CLI use)
export interface ContractYaml {
  schema_version?: number;
  id?: string;
  title: string;
  background?: string;      // 用户意图
  goal: string;
  expectations?: string;    // 全局执行要求和质量期望
  subtasks: Array<{
    id: string;
    description: string;
  }>;
  acceptance?: Array<
    | { subtask_id: string; type: 'script'; script_file?: string }
    | { subtask_id: string; type: 'llm'; prompt_file?: string }
  >;
  auth_level?: 'auto' | 'notify' | 'confirm';
  escalation?: {
    max_retries?: number;  // 默认 3
  };
}

// Progress data structure
export interface ProgressData {
  contract_id: string;
  status: ContractStatus;
  subtasks: Record<string, {
    status: SubtaskStatus;
    completed_at?: string;
    evidence?: string;
    artifacts?: string[];
    retry_count?: number;           // 默认 0，每次验收失败 +1
    last_failed_feedback?: string;
    escalated_at?: string;
  }>;
  started_at?: string;
  checkpoint?: string | null;
}

export interface AcceptanceResult {
  passed: boolean;
  feedback: string;
  allCompleted?: boolean;  // 仅 passed=true 时有意义
  async?: boolean;         // true 时代表验收已提交后台，结果由 inbox 通知
  structured?: { passed: boolean; reason: string; issues?: string[] };  // LLM 验收的结构化结果
}

export class ContractManager {
  private fs: FileSystem;
  private clawDir: string;
  private readonly clawId: string;
  private readonly audit: AuditWriter;
  private llm?: LLMService;
  private verifierRegistry?: ToolRegistryImpl;
  private verifierScheduler: ContractVerifierScheduler;
  private activeDir = 'contract/active';
  private pausedDir = 'contract/paused';
  private archiveDir = 'contract/archive';
  private auditWriter?: AuditWriter;
  onNotify?: (type: string, data: Record<string, unknown>) => void;

  constructor(
    clawDir: string,
    clawId: string,
    fs: FileSystem,
    audit: AuditWriter,
    llm?: LLMService,
    verifierRegistry?: ToolRegistryImpl,
    auditWriter?: AuditWriter,
    verifierScheduler?: ContractVerifierScheduler,
  ) {
    this.auditWriter = auditWriter;
    this.clawDir = clawDir;
    this.clawId = clawId;
    this.fs = fs;
    this.audit = audit;
    this.llm = llm;
    this.verifierRegistry = verifierRegistry;
    this.verifierScheduler = verifierScheduler ?? createSubAgentVerifierScheduler();
  }

  setOnNotify(cb: (type: string, data: Record<string, unknown>) => void): void {
    this.onNotify = cb;
  }

  /**
   * Returns the directory prefix where the contract currently resides (active, paused, or archive)
   */
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

  /**
   * Acquire a file lock (exclusive creation mode)
   * Uses writeAtomic + exists check to simulate exclusive creation
   */
  private async acquireLock(lockPath: string): Promise<void> {
    const absoluteLockPath = path.join(this.clawDir, lockPath);
    // 路径安全：确保解析后的路径仍在 clawDir 内
    if (!absoluteLockPath.startsWith(this.clawDir + path.sep) && absoluteLockPath !== this.clawDir) {
      throw new ToolError(`Lock path escapes clawDir: ${lockPath}`);
    }
    await fsNative.promises.mkdir(path.dirname(absoluteLockPath), { recursive: true });

    let lastReason = 'unknown';

    for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
      try {
        // wx flag = O_EXCL: 文件存在时原子性失败，无 TOCTOU
        await fsNative.promises.writeFile(
          absoluteLockPath,
          JSON.stringify({ pid: process.pid, time: Date.now() }),
          { flag: 'wx' }
        );
        return; // 成功获取锁
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err; // 非竞争错误，向上抛

        // EEXIST：尝试检测 stale lock（持有者进程已死或持锁超时）
        try {
          const raw = await fsNative.promises.readFile(absoluteLockPath, 'utf-8');
          const { pid, time } = JSON.parse(raw) as { pid: number; time: number };
          let isAlive = true;
          try { process.kill(pid, 0); } catch { isAlive = false; }
          if (!isAlive) {
            // 持有者已死，清理 stale lock 后立即重试（不计入重试次数）
            lastReason = `holder PID ${pid} is dead (stale lock)`;
            if (await this.unlinkStaleLock(absoluteLockPath, `stale_pid_${pid}`)) continue;
            lastReason = `unlink failed on stale lock (PID ${pid})`;
          } else if (Date.now() - time > LOCK_STALE_TIMEOUT_MS) {
            // 持有者存活但持锁超时：强制清理（防止 bug 导致永久死锁）
            lastReason = `holder PID ${pid} exceeded timeout (${LOCK_STALE_TIMEOUT_MS}ms)`;
            this.auditWriter?.write(
              CONTRACT_AUDIT_EVENTS.LOCK_CLEARED,
              `pid=${pid}`,
              `timeout=${LOCK_STALE_TIMEOUT_MS}`,
              'reason=stale',
            );
            if (await this.unlinkStaleLock(absoluteLockPath, `timeout_pid_${pid}`)) continue;
            lastReason = `unlink failed on timeout lock (PID ${pid})`;
          } else {
            lastReason = `held by PID ${pid} (${Math.round((Date.now() - time) / 1000)}s)`;
          }
        } catch {
          // 读取或解析失败：lock 文件损坏，清理后重试
          lastReason = 'lock file corrupt or unreadable';
          if (await this.unlinkStaleLock(absoluteLockPath, 'corrupt_lock_file')) continue;
          lastReason = 'unlink failed on corrupt lock file';
        }

        // 持有者还活着，等待后重试
        if (i < LOCK_MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
        }
      }
    }
    throw new ToolError(`Failed to acquire lock after ${LOCK_MAX_RETRIES} retries: ${lockPath} (${lastReason})`);
  }

  /**
   * 清理 stale lock 文件；区分 ENOENT（预期/已被其他路径清理）与真故障（权限/IO）。
   * @returns true 表示 lock 文件已不存在或成功删除；false 表示删除失败需外层重试
   */
  private async unlinkStaleLock(absoluteLockPath: string, reason: string): Promise<boolean> {
    try {
      await fsNative.promises.unlink(absoluteLockPath);
      return true;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return true; // 已被其他路径清理，等同成功
      // 真故障（权限/IO）：记 audit（phase230 清零后 / L232 已 audit 化 / 循环外层通过 audit.tsv 审计）
      this.auditWriter?.write(
        'contract_lock_cleanup_failed',
        reason,
        err?.code ?? 'unknown',
        err?.message ?? String(err),
      );
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.LOCK_UNLINK_FAILED,
        `reason=${reason}`,
        `err=${err?.message ?? String(err)}`,
      );
      return false;
    }
  }

  /**
   * Release the file lock
   */
  private async releaseLock(lockPath: string): Promise<void> {
    try {
      await this.fs.delete(lockPath);
    } catch (e) {
      // Ignore deletion failure (may have already been cleaned up by another process)
      this.audit.write(CONTRACT_AUDIT_EVENTS.LOCK_UNLINK_FAILED, `context=ContractManager.releaseLock`, `lockPath=${lockPath}`, `error=${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Lock-protected progress.json update
   */
  private async withProgressLock<T>(contractId: string, fn: () => Promise<T>): Promise<T> {
    const dir = await this.contractDir(contractId);
    const lockPath = `${dir}/${contractId}/progress.lock`;
    await this.acquireLock(lockPath);
    try {
      return await fn();
    } finally {
      await this.releaseLock(lockPath);
    }
  }

  /**
   * Load the currently active contract (returns the most recent contract in the active/ directory)
   */
  async loadActive(): Promise<Contract | null> {
    const exists = await this.fs.exists(this.activeDir);
    if (!exists) return null;

    // Scan the contract/active/ directory — contracts inside are active (do not check the status field)
    const entries = await this.fs.list(this.activeDir, { includeDirs: true });
    
    let latest: { name: string; startedAt: string } | null = null;
    
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      
      const progressPath = `${this.activeDir}/${entry.name}/progress.json`;
      const hasProgress = await this.fs.exists(progressPath);
      if (!hasProgress) continue;

      try {
        const progressData = JSON.parse(await this.fs.read(progressPath)) as ProgressData;
        // Contracts in the active/ directory are active — trust directory location, do not check the status field
        const startedAt = progressData.started_at ?? '';
        if (!latest || startedAt > latest.startedAt) {
          latest = { name: entry.name, startedAt };
        }
      } catch (error) {
        // Distinguish file-not-found (ENOENT, skip normally) from other errors (JSON parse failure, corruption, etc.)
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          this.auditWriter?.write(
            CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
            `file=${entry.name}`,
            `err=${error instanceof Error ? error.message : String(error)}`,
          );
          this.audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED, `context=${'ContractManager.loadActive'}`, `contract=${entry.name}`, `error=${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
    }

    if (!latest) return null;
    const contract = await this.loadContract(latest.name);
    contract.status = 'running';   // 目录位置决定状态（P1）
    return contract;
  }

  /**
   * Load the currently paused contract (returns the most recent contract in the paused/ directory)
   */
  async loadPaused(): Promise<Contract | null> {
    const exists = await this.fs.exists(this.pausedDir);
    if (!exists) return null;

    const entries = await this.fs.list(this.pausedDir, { includeDirs: true });
    let latest: { name: string; startedAt: string } | null = null;

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const progressPath = `${this.pausedDir}/${entry.name}/progress.json`;
      const hasProgress = await this.fs.exists(progressPath);
      if (!hasProgress) continue;

      try {
        const data = JSON.parse(await this.fs.read(progressPath)) as ProgressData;
        const startedAt = data.started_at ?? '';
        if (!latest || startedAt > latest.startedAt) {
          latest = { name: entry.name, startedAt };
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          this.auditWriter?.write(
            CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
            `file=${entry.name}`,
            `err=${error instanceof Error ? error.message : String(error)}`,
          );
          this.audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED, `context=${'ContractManager.loadPaused'}`, `contract=${entry.name}`, `error=${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
    }

    if (!latest) return null;
    const contract = await this.loadContract(latest.name);
    contract.status = 'paused';    // 目录位置决定状态（P1）
    return contract;
  }

  /**
   * Create a new contract
   */
  async create(contractYaml: ContractYaml): Promise<string> {
    const contractId = contractYaml.id || `${Date.now()}-${randomUUID().slice(0, 8)}`;

    // Validate subtasks: must have at least one subtask
    if (!contractYaml.subtasks || contractYaml.subtasks.length === 0) {
      throw new Error('Contract must have at least one subtask');
    }

    // Validate acceptance config: type/field binding must match
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

    // Validate acceptance config: no duplicate subtask_id
    const seenSubtaskIds = new Set<string>();
    for (const a of contractYaml.acceptance ?? []) {
      if (seenSubtaskIds.has(a.subtask_id)) {
        throw new Error(
          `acceptance config: duplicate subtask_id "${a.subtask_id}" — each subtask can only have one acceptance entry`
        );
      }
      seenSubtaskIds.add(a.subtask_id);
    }

    // Archive any existing active contract (prevents conflicts with multiple running contracts)
    const existing = await this.loadActive();
    if (existing && existing.id !== contractId) {
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.ARCHIVE_STARTED,
        `old=${existing.id}`,
        `new=${contractId}`,
      );
      await this.moveToArchive(existing.id);
    }

    await this.fs.ensureDir(`${this.activeDir}/${contractId}`);

    // Write contract.yaml (populate defaults; write id to ensure consistency)
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

    // Write initial progress.json
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
      // 清理整个合约目录，避免残留空目录或孤立文件在 active/
      await this.fs.removeDir(`${this.activeDir}/${contractId}`).catch((deleteErr) => {
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.ROLLBACK_FAILED,
          `contractId=${contractId}`,
          `err=${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`,
        );
      });
      throw err;
    }

    try {
      this.onNotify?.('contract_created', { contractId, title: contractYaml.title, subtaskCount: contractYaml.subtasks.length });
    } catch (err) {
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
        `err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.auditWriter?.write('contract_created', contractId, `subtasks=${contractYaml.subtasks.length}`, `title=${contractYaml.title}`);
    this.audit.write(CONTRACT_AUDIT_EVENTS.CREATED, `contractId=${contractId}`);
    return contractId;
  }

  /**
   * Read the progress of a contract
   */
  async getProgress(contractId: string): Promise<ProgressData> {
    const dir = await this.contractDir(contractId);
    const progressPath = `${dir}/${contractId}/progress.json`;
    const content = await this.fs.read(progressPath);
    return JSON.parse(content) as ProgressData;
  }

  /**
   * Mark a subtask as complete and trigger acceptance
   * 
   * If acceptance is configured, runs asynchronously and returns { async: true }
   * Result will be delivered via inbox message
   */
  async completeSubtask(params: {
    contractId: string;
    subtaskId: string;
    evidence: string;
    artifacts?: string[];
  }): Promise<AcceptanceResult> {
    const { contractId, subtaskId, evidence, artifacts } = params;

    // Load contract YAML to get acceptance configuration
    const contractYaml = await this.loadContractYaml(contractId);
    
    // Run acceptance check
    const acceptanceConfig = contractYaml.acceptance?.find(
      a => a.subtask_id === subtaskId
    );

    // No acceptance criteria configured: pass immediately (sync)
    if (!acceptanceConfig) {
      return this._completeSubtaskSync(contractId, subtaskId, evidence, artifacts);
    }

    // Has acceptance config: verify subtask exists, mark in_progress, then async
    await this.withProgressLock(contractId, async () => {
      const progress = await this.getProgress(contractId);
      
      // Verify subtaskId exists
      if (!progress.subtasks[subtaskId]) {
        const validIds = Object.keys(progress.subtasks).join(', ');
        throw new ToolError(`Unknown subtask "${subtaskId}". Valid subtask IDs: ${validIds}`);
      }

      // Guard: reject duplicate done() call
      const currentStatus = progress.subtasks[subtaskId].status;
      if (currentStatus === 'in_progress') {
        throw new ToolError(`Subtask "${subtaskId}" acceptance is already in progress — duplicate done() call ignored.`);
      }
      if (currentStatus === 'completed') {
        throw new ToolError(`Subtask "${subtaskId}" is already completed.`);
      }
      
      // Mark as in_progress during acceptance verification
      progress.subtasks[subtaskId] = {
        ...progress.subtasks[subtaskId], // 保留 retry_count / last_failed_feedback
        status: 'in_progress',
        evidence,
        artifacts,
      };
      
      await this.saveProgress(contractId, progress);
      
      this.audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_STARTED, `contractId=${contractId}`, `subtaskId=${subtaskId}`);
    });

    // Start background acceptance (fire-and-forget)
    this._runAcceptanceInBackground(params, contractYaml, acceptanceConfig)
      .catch(err => {
        this.audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED, `context=ContractManager.backgroundAcceptance`, `contractId=${contractId}`, `subtaskId=${subtaskId}`, `error=${err instanceof Error ? err.message : String(err)}`);
        return this._writeAcceptanceError(contractId, subtaskId, err);
      });

    // Return immediately with async flag
    return { passed: false, feedback: '', async: true };
  }

  /**
   * Synchronous completion (no acceptance configured)
   */
  private async _completeSubtaskSync(
    contractId: string,
    subtaskId: string,
    evidence: string,
    artifacts?: string[],
  ): Promise<AcceptanceResult> {
    let allCompleted = false;
    let result: AcceptanceResult = { passed: true, feedback: 'No acceptance criteria configured' };
    const contractYaml = await this.loadContractYaml(contractId);
    
    await this.withProgressLock(contractId, async () => {
      const progress = await this.getProgress(contractId);
      
      // Verify subtaskId exists
      if (!progress.subtasks[subtaskId]) {
        const validIds = Object.keys(progress.subtasks).join(', ');
        result = { passed: false, feedback: `Unknown subtask "${subtaskId}". Valid subtask IDs: ${validIds}` };
        this.audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED, `context=ContractManager._completeSubtaskSync`, `contractId=${contractId}`, `subtaskId=${subtaskId}`, `message=Unknown subtaskId`);
        return;
      }

      // Guard: skip if acceptance already running or subtask already completed
      const currentStatus = progress.subtasks[subtaskId].status;
      if (currentStatus === 'in_progress') {
        result = { passed: false, feedback: `Subtask "${subtaskId}" acceptance is already in progress — duplicate done() call ignored.` };
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.SUBTASK_DUPLICATE_DONE,
          `contractId=${contractId}`,
          `subtaskId=${subtaskId}`,
        );
        return;
      }
      if (currentStatus === 'completed') {
        result = { passed: false, feedback: `Subtask "${subtaskId}" is already completed.` };
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.SUBTASK_ALREADY_COMPLETED,
          `contractId=${contractId}`,
          `subtaskId=${subtaskId}`,
        );
        return;
      }
      
      progress.subtasks[subtaskId] = {
        ...progress.subtasks[subtaskId],
        status: 'completed',
        completed_at: new Date().toISOString(),
        evidence,
        artifacts,
      };
      try {
        this.onNotify?.('subtask_completed', { contractId, subtaskId });
      } catch (err) {
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
          `err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const subtaskTotal = contractYaml.subtasks.length;
      const completedCount = Object.values(progress.subtasks).filter(s => s.status === 'completed').length;
      // Audit: subtask_completed
      this.auditWriter?.write(
        'subtask_completed',
        `${contractId}/${subtaskId}`,
        `progress=${completedCount}/${subtaskTotal}`,
        `claw=${this.clawId}`,
      );

      // Check whether all subtasks are complete
      allCompleted = await this.checkAllCompleted(contractId, progress);
      if (allCompleted) {
        progress.status = 'completed';
        await this.updateContractStatus(contractId, 'completed');
      }

      await this.saveProgress(contractId, progress);
      
      this.audit.write(CONTRACT_AUDIT_EVENTS.UPDATED, `contractId=${contractId}`, `subtaskId=${subtaskId}`, `status=${allCompleted ? 'completed' : 'running'}`);
    });

    // Archive and log completion outside the lock (best-effort)
    if (allCompleted) {
      const title = contractYaml.title;
      try {
        await this.moveToArchive(contractId);
        this.auditWriter?.write(
          'contract_completed',
          contractId,
          `title=${title}`,
          `claw=${this.clawId}`,
        );
      } catch (err) {
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED,
          `err=${err instanceof Error ? err.message : String(err)}`,
        );
        this.audit.write(CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED, `context=${'ContractManager._completeSubtaskSync'}`, `message=${'moveToArchive failed; contract stays in active/'}`, `error=${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    return { ...result, allCompleted };
  }

  /**
   * Run acceptance verification in background
   */
  private async _runAcceptanceInBackground(
    params: { contractId: string; subtaskId: string; evidence: string; artifacts?: string[] },
    contractYaml: ContractYaml,
    acceptanceConfig: { subtask_id: string; type: 'script'; script_file?: string } | { subtask_id: string; type: 'llm'; prompt_file?: string },
  ): Promise<void> {
    const { contractId, subtaskId, evidence, artifacts = [] } = params;
    
    // Get subtask description from contract YAML
    const subtaskDef = contractYaml.subtasks.find(st => st.id === subtaskId);
    const subtaskDesc = subtaskDef?.description || subtaskId;
    
    // Run acceptance check
    const contractAbsDir = path.join(this.clawDir, await this.contractDir(contractId), contractId);
    let result: AcceptanceResult;

    if (acceptanceConfig.type === 'script') {
      const scriptFile = acceptanceConfig.script_file;
      if (!scriptFile) {
        result = { passed: false, feedback: 'acceptance config script 类型缺少 script_file' };
        this.audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED, `context=${'ContractManager._runAcceptanceInBackground'}`, `message=${'acceptance config missing script_file'}`);
      } else {
        result = await this.runScriptAcceptance(scriptFile, contractAbsDir);
      }
    } else {
      const promptFile = acceptanceConfig.prompt_file;
      if (!promptFile) {
        result = { passed: false, feedback: 'acceptance config llm 类型缺少 prompt_file' };
        this.audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED, `context=${'ContractManager._runAcceptanceInBackground'}`, `message=${'acceptance config missing prompt_file'}`);
      } else {
        result = await this.runLLMAcceptance(
          promptFile,
          contractAbsDir,
          contractId,
          subtaskId,
          subtaskDesc,
          evidence,
          artifacts,
        );
      }
    }

    // Handle acceptance result
    await this.withProgressLock(contractId, async () => {
      const progress = await this.getProgress(contractId);
      const subtask = progress.subtasks[subtaskId];
      
      if (!subtask) {
        this.audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED, `context=ContractManager._runAcceptanceInBackground`, `contractId=${contractId}`, `subtaskId=${subtaskId}`, `error=subtask missing from progress after in_progress mark`);
        return;
      }
      
      if (result.passed) {
        // Mark completed
        subtask.status = 'completed';
        subtask.completed_at = new Date().toISOString();
        try {
          this.onNotify?.('subtask_completed', { contractId, subtaskId });
        } catch (err) {
          this.auditWriter?.write(
            CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
            `err=${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const subtaskTotal = contractYaml.subtasks.length;
        const completedCount = Object.values(progress.subtasks).filter(s => s.status === 'completed').length;
        // Audit: subtask_completed
        this.auditWriter?.write(
          'subtask_completed',
          `${contractId}/${subtaskId}`,
          `progress=${completedCount}/${subtaskTotal}`,
          `claw=${this.clawId}`,
        );

        // Audit: acceptance_passed
        this.auditWriter?.write('acceptance_passed', `${contractId}/${subtaskId}`);

        // Check all completed
        const allCompleted = await this.checkAllCompleted(contractId, progress);
        if (allCompleted) {
          progress.status = 'completed';
          await this.updateContractStatus(contractId, 'completed');
        }
        
        await this.saveProgress(contractId, progress);
        
        // Write inbox notification to claw
        this._writeAcceptanceInbox(contractId, subtaskId, 'passed', allCompleted);
        
        // Audit log if all completed
        if (allCompleted) {
          try {
            await this.moveToArchive(contractId);
            this.auditWriter?.write(
              'contract_completed',
              contractId,
              `title=${contractYaml.title}`,
              `claw=${this.clawId}`,
            );
          } catch (err) {
            this.auditWriter?.write(
              CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED,
              `err=${err instanceof Error ? err.message : String(err)}`,
            );
            this.audit.write(CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED, `context=${'ContractManager._runAcceptanceInBackground'}`, `message=${'moveToArchive failed; contract stays in active/'}`, `error=${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else {
        // Rejected - track retry count and feedback
        subtask.retry_count = (subtask.retry_count || 0) + 1;
        subtask.last_failed_feedback = result.feedback;
        
        // Reset to todo for retry
        subtask.status = 'todo';
        
        try {
          this.onNotify?.('acceptance_failed', { contractId, subtaskId, feedback: result.feedback });
        } catch (err) {
          this.auditWriter?.write(
            CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
            `err=${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Audit: acceptance_failed
        this.auditWriter?.write(
          'acceptance_failed',
          `${contractId}/${subtaskId}`,
          `feedback=${result.feedback}`,
        );

        await this.saveProgress(contractId, progress);
        
        // Format rejection feedback
        const maxRetries = contractYaml.escalation?.max_retries ?? 3;
        const acceptanceFile = acceptanceConfig.type === 'script' 
          ? acceptanceConfig.script_file ?? 'unknown'
          : acceptanceConfig.prompt_file ?? 'unknown';
        const formattedFeedback = result.structured
          ? this.formatRejectionFeedback(
              subtaskId,
              subtaskDesc,
              result.structured.reason,
              result.structured.issues || [],
              subtask.retry_count,
              maxRetries,
              acceptanceConfig.type,
              acceptanceFile,
            )
          : result.feedback;
        
        // Write inbox rejection notification
        this._writeAcceptanceInbox(contractId, subtaskId, 'rejected', false, formattedFeedback, subtask.retry_count);
        
        // Escalate if too many retries
        if (subtask.retry_count >= maxRetries) {
          subtask.escalated_at = new Date().toISOString();
          await this.saveProgress(contractId, progress);
          this.auditWriter?.write(
            'contract_escalation',
            `${contractId}/${subtaskId}`,
            `retry_count=${subtask.retry_count}`,
            `claw=${this.clawId}`,
          );
        }
      }
    });
  }

  /**
   * Write acceptance result to claw inbox
   */
  private _writeAcceptanceInbox(
    contractId: string,
    subtaskId: string,
    verdict: 'passed' | 'rejected',
    allCompleted: boolean,
    feedback?: string,
    retryCount?: number,
  ): void {
    const extraFields: Record<string, string> = {
      contract_id: contractId,
      subtask_id: subtaskId,
      verdict,
    };
    if (retryCount !== undefined) extraFields.retry_count = String(retryCount);

    let body: string;
    if (verdict === 'passed') {
      body = allCompleted
        ? `Subtask ${subtaskId} accepted. All subtasks complete!`
        : `Subtask ${subtaskId} accepted.`;
    } else {
      body = feedback || 'No feedback provided';
    }

    const audit = this.auditWriter ?? new AuditWriter(this.fs, path.join(this.clawDir, 'audit.tsv'));
    new InboxWriter(
      this.fs,
      path.join(this.clawDir, 'inbox', 'pending'),
      audit,
    ).writeSync({
      type: verdict === 'passed' ? 'acceptance_result' : 'acceptance_rejection',
      source: 'contract_system',
      to: this.clawId,
      priority: verdict === 'rejected' ? 'high' : 'normal',
      body,
      filenameTag: verdict === 'rejected' ? 'high' : 'normal',
      extraFields,
    });
  }

  /**
   * Write acceptance error to claw inbox (best-effort)
   */
  private async _writeAcceptanceError(contractId: string, subtaskId: string, error: unknown): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : String(error);

    try {
      const audit = this.auditWriter ?? new AuditWriter(this.fs, path.join(this.clawDir, 'audit.tsv'));
      new InboxWriter(
        this.fs,
        path.join(this.clawDir, 'inbox', 'pending'),
        audit,
      ).writeSync({
        type: 'acceptance_error',
        source: 'contract_system',
        to: this.clawId,
        priority: 'high',
        body: `Acceptance verification failed with error: ${errorMsg}`,
        idPrefix: 'acceptance_error',
        filenameTag: 'high',
        extraFields: {
          contract_id: contractId,
          subtask_id: subtaskId,
        },
      });
    } catch (e) {
      // Best-effort: log but don't throw
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_INBOX_FAILED,
        `err=${e instanceof Error ? e.message : String(e)}`,
      );
      this.audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_INBOX_FAILED, `context=${'ContractManager._writeAcceptanceError'}`, `error=${e instanceof Error ? e.message : String(e)}`);
    }

    // 重置 subtask 状态，防止永久卡在 in_progress
    try {
      await this.withProgressLock(contractId, async () => {
        const progress = await this.getProgress(contractId);
        const subtask = progress.subtasks[subtaskId];
        if (subtask && subtask.status === 'in_progress') {
          subtask.status = 'todo';
          subtask.retry_count = (subtask.retry_count || 0) + 1;
          subtask.last_failed_feedback = `acceptance error: ${errorMsg}`;
          await this.saveProgress(contractId, progress);
        }
      });
    } catch (e) {
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
        `err=${e instanceof Error ? e.message : String(e)}`,
      );
      this.audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED, `context=${'ContractManager._writeAcceptanceError.resetStatus'}`, `error=${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Format rejection feedback for claw with structured information
   */
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
    const issuesList = issues.length > 0
      ? issues.map(i => `- ${i}`).join('\n')
      : '- (未提供具体问题)';

    return [
      `## 验收失败 — ${subtaskId}`,
      '',
      `**子任务：** ${subtaskDesc}`,
      '',
      '**失败原因：**',
      reason,
      '',
      '**需要修正的问题：**',
      issuesList,
      '',
      `**验收标准：** ${acceptanceType} (${acceptanceFile})`,
      '',
      `已失败 ${retryCount}/${maxRetries} 次。`,
    ].join('\n');
  }

  /**
   * Pause a contract (move from active/ to paused/)
   */
  async pause(contractId: string, checkpointNote: string): Promise<void> {
    const dir = await this.contractDir(contractId);
    if (dir !== this.activeDir) {
      throw new ToolError(`Cannot pause contract "${contractId}": not in active/`);
    }
    // Move directory first — filesystem location is source of truth
    await this.fs.ensureDir(this.pausedDir);
    await this.fs.move(
      `${this.activeDir}/${contractId}`,
      `${this.pausedDir}/${contractId}`
    );
    // Update progress.json at new location inside lock
    await this.withProgressLock(contractId, async () => {
      const progress = await this.getProgress(contractId);
      progress.status = 'paused';
      progress.checkpoint = checkpointNote;
      await this.saveProgress(contractId, progress);
    });
    this.auditWriter?.write('contract_paused', contractId, `checkpoint=${checkpointNote}`);
  }

  /**
   * Resume a contract (move from paused/ to active/)
   */
  async resume(contractId: string): Promise<Contract> {
    const dir = await this.contractDir(contractId);
    if (dir !== this.pausedDir) {
      throw new ToolError(`Cannot resume contract "${contractId}": not in paused/`);
    }
    // Move directory first — filesystem location is source of truth
    await this.fs.move(
      `${this.pausedDir}/${contractId}`,
      `${this.activeDir}/${contractId}`
    );
    // Update progress.json at new location inside lock
    await this.withProgressLock(contractId, async () => {
      const progress = await this.getProgress(contractId);
      progress.status = 'running';
      progress.checkpoint = null;
      await this.saveProgress(contractId, progress);
    });
    this.auditWriter?.write('contract_resumed', contractId);
    return this.loadContract(contractId);
  }

  /**
   * Cancel a contract (move from active/ or paused/ to archive/)
   */
  async cancel(contractId: string, reason: string): Promise<void> {
    const dir = await this.contractDir(contractId);
    if (dir === this.archiveDir) {
      throw new ToolError(`Cannot cancel contract "${contractId}": already archived`);
    }
    // Move directory first — filesystem location is source of truth
    await this.fs.ensureDir(this.archiveDir);
    await this.fs.move(`${dir}/${contractId}`, `${this.archiveDir}/${contractId}`);
    // Update progress.json at new location inside lock
    await this.withProgressLock(contractId, async () => {
      const progress = await this.getProgress(contractId);
      progress.status = 'cancelled';
      progress.checkpoint = `cancelled: ${reason}`;
      await this.saveProgress(contractId, progress);
    });
    this.auditWriter?.write('contract_cancelled', contractId, `reason=${reason}`);
  }

  /**
   * Move a contract from active/ or paused/ to archive/
   */
  private async moveToArchive(contractId: string): Promise<void> {
    const dir = await this.contractDir(contractId);
    if (dir === this.archiveDir) return; // Already in archive
    const dst = `${this.archiveDir}/${contractId}`;
    await this.fs.ensureDir(this.archiveDir);
    await this.fs.move(`${dir}/${contractId}`, dst);
  }

  /**
   * Check whether all subtasks are complete
   */
  async isComplete(contractId: string): Promise<boolean> {
    const progress = await this.getProgress(contractId);
    return this.checkAllCompleted(contractId, progress);
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private async loadContractYaml(contractId: string): Promise<ContractYaml> {
    const dir = await this.contractDir(contractId);
    const contractPath = `${dir}/${contractId}/contract.yaml`;
    const content = await this.fs.read(contractPath);
    return yaml.load(content) as ContractYaml;
  }

  // 新增：供外部（daemon.ts）直接读取 YAML 原始字符串
  public async readContractYamlRaw(contractId: string): Promise<string> {
    const dir = await this.contractDir(contractId);
    const contractPath = `${dir}/${contractId}/contract.yaml`;
    return this.fs.read(contractPath);
  }

  private async loadContract(contractId: string): Promise<Contract> {
    const yamlContract = await this.loadContractYaml(contractId);
    const progress = await this.getProgress(contractId);

    // Convert YAML format to the Contract interface (using unified defaults)
    return {
      id: yamlContract.id ?? contractId,
      title: yamlContract.title,
      description: yamlContract.goal,
      status: progress.status,
      priority: 'normal',
      creator: 'system',
      goal: yamlContract.goal,
      subtasks: yamlContract.subtasks.map(st => ({
        id: st.id,
        description: st.description,
        status: progress.subtasks[st.id]?.status || 'todo',
        created_at: progress.started_at || new Date().toISOString(),
        updated_at: progress.subtasks[st.id]?.completed_at || new Date().toISOString(),
      })),
      auth_level: yamlContract.auth_level ?? CONTRACT_DEFAULTS.auth_level,
      created_at: progress.started_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  private async saveProgress(contractId: string, progress: ProgressData): Promise<void> {
    const dir = await this.contractDir(contractId);
    const progressPath = `${dir}/${contractId}/progress.json`;
    await this.fs.writeAtomic(progressPath, JSON.stringify(progress, null, 2));
  }

  private async updateContractStatus(contractId: string, status: ContractStatus): Promise<void> {
    // In Phase 1, the contract YAML is read-only; status changes are recorded in progress.json
    // In a real project, you may need to update the status field in the contract file itself
    if (status === 'completed') {
      this.auditWriter?.write('contract_completed', contractId);
    }
  }

  private async checkAllCompleted(contractId: string, progress: ProgressData): Promise<boolean> {
    const contractYaml = await this.loadContractYaml(contractId);
    return contractYaml.subtasks.every(st => 
      progress.subtasks[st.id]?.status === 'completed'
    );
  }

  private async runScriptAcceptance(
    scriptFile: string,
    contractAbsDir: string,
  ): Promise<AcceptanceResult> {
    // 路径安全：script_file 必须在契约目录内（ContractSystem 业务语义）
    const resolved = path.resolve(contractAbsDir, scriptFile);
    if (!resolved.startsWith(contractAbsDir + path.sep)) {
      return { passed: false, feedback: `路径安全拒绝: script_file 必须在契约目录内` };
    }

    this.auditWriter?.write(
      CONTRACT_AUDIT_EVENTS.ACCEPTANCE_SCRIPT_STARTED,
      `script=${scriptFile}`,
      `cwd=${this.clawDir}`,
    );

    try {
      await execFile('sh', [resolved], {
        cwd: this.clawDir,
        timeout: CONTRACT_SCRIPT_TIMEOUT_MS,
      });
      return { passed: true, feedback: 'Script acceptance passed' };
    } catch (err) {
      if (!(err instanceof ProcessExecError)) {
        return { passed: false, feedback: `验收失败: ${err instanceof Error ? err.message : String(err)}` };
      }

      const prefix = err.killed ? '验收脚本超时' : '验收失败';
      const detail = err.stderr || err.stdout || err.message;
      const firstLine = detail.split('\n').find(l => l.trim()) ?? detail.trim();
      return { passed: false, feedback: `${prefix}: ${firstLine}` };
    }
  }

  /**
   * Run LLM acceptance verification using SubAgent
   */
  private async runLLMAcceptance(
    promptFile: string,
    contractAbsDir: string,
    contractId: string,
    subtaskId: string,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
  ): Promise<AcceptanceResult> {
    // LLM not injected
    if (!this.llm) {
      return { passed: false, feedback: 'LLM 验收未配置（llm 未注入）' };
    }

    // Path security check
    const resolved = path.resolve(contractAbsDir, promptFile);
    if (!resolved.startsWith(contractAbsDir + path.sep)) {
      return { passed: false, feedback: '路径安全拒绝: prompt_file 必须在契约目录内' };
    }

    try {
      // Read prompt template
      const relativePath = path.relative(this.clawDir, resolved);
      if (relativePath.startsWith('..')) {
        return { passed: false, feedback: '路径安全拒绝: prompt_file 解析后逃出 claw 目录' };
      }
      const promptTemplate = await this.fs.read(relativePath);

      // Inject variables
      const filledPrompt = promptTemplate
        .replace(/\{\{evidence\}\}/g, evidence)
        .replace(/\{\{artifacts\}\}/g, artifacts.join(', '))
        .replace(/\{\{subtask_description\}\}/g, subtaskDesc);

      // Delegate to ContractVerifierScheduler port
      const result = await this.verifierScheduler.schedule({
        agentId: `verifier-${contractId}-${subtaskId}`,
        prompt: filledPrompt,
        systemPrompt: CONTRACT_VERIFIER_SYSTEM_PROMPT,
        clawDir: this.clawDir,
        llm: this.llm!,
        registry: this.verifierRegistry ?? new ToolRegistryImpl(),
        fs: this.fs,
        maxSteps: DEFAULT_MAX_STEPS,
        idleTimeoutMs: DEFAULT_LLM_IDLE_TIMEOUT_MS,
        onIdleTimeout: () => {
          this.auditWriter?.write(
            'acceptance_timeout',
            `${contractId}/${subtaskId}`,
            `claw=${this.clawId}`,
          );
        },
      });
      return result;
    } catch (err) {
      if (err instanceof ToolTimeoutError) {
        return { passed: false, feedback: '验收子代理超时' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { passed: false, feedback: `LLM 验收失败: ${msg}` };
    }
  }

  /**
   * 处理单条 review_request（contract 完成后的 retro 整合动作，motion 独有）。
   *
   * 应然语义（Step 3-5 填充）：
   *   1. 读 motion fs 的 by-contract/<id>.json 索引（best-effort skip 4 分支）
   *   2. 加载 target claw 的 contract YAML（best-effort skip 1 分支）
   *   3. 扫 motion fs 的 dispatch-skills（best-effort 退化 1 分支）
   *   4. 加载 mining task messages（若 mining 模式，best-effort 退化 2 分支）
   *   5. 构造 retro prompt + 派发 retro subagent（writePending 失败 continue 不清 by-contract）
   *   6. cleanup by-contract 索引（best-effort 1 分支）
   *
   * 完整行为契约见 `design/modules/l4_contract_system.md` §2.b.1。
   *
   * 空壳（phase175 Step 2）：不执行任何动作，仅占位使调用方可 import。
   * 完整实现：phase175 Step 3-5。
   */
  async handleReviewRequest(
    contractId: string,
    ctx: MotionReviewContext,
  ): Promise<void> {
    // Part 1: by-contract 索引解析（daemon.ts:124-158 等价迁移）
    const byContractPath = path.join(
      ctx.motionBaseDir,
      'clawspace', 'pending-retrospective', 'by-contract',
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
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.RETRO_INDEX_FAILED,
          `contractId=${contractId}`,
          'reason=invalid_json',
        );
        return;
      }
      if (typeof raw !== 'object' || raw === null) {
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.RETRO_INDEX_FAILED,
          `contractId=${contractId}`,
          'reason=unexpected_format',
        );
        return;
      }
      const r = raw as Record<string, unknown>;
      const rawTarget = typeof r.targetClaw === 'string' ? r.targetClaw : null;
      if (!rawTarget || !/^[a-z0-9-]+$/.test(rawTarget)) {
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.RETRO_INDEX_FAILED,
          `contractId=${contractId}`,
          `reason=invalid_targetClaw`,
          `rawTarget=${rawTarget ?? 'null'}`,
        );
        return;
      }
      targetClaw = rawTarget;
      // Part 1 回填：mode / miningTaskId（Step 3 预留，Step 4 回填）
      mode = typeof r.mode === 'string' ? r.mode : undefined;
      miningTaskId = typeof r.miningTaskId === 'string' ? r.miningTaskId : undefined;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.auditWriter?.write(
          CONTRACT_AUDIT_EVENTS.RETRO_INDEX_FAILED,
          `contractId=${contractId}`,
          `err=${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }

    // Part 2: contract YAML + skills + mining messages（daemon.ts:160-213 等价）

    // 2.1 加载契约 YAML（临时 new ContractManager for target claw，B.p175-2 登记）
    const clawDir = path.join(ctx.clawsBaseDir, targetClaw);
    const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
    const clawContractManager = new ContractManager(clawDir, targetClaw, clawFs, new AuditWriter(clawFs, path.join(clawDir, 'audit.tsv')));

    let contractYaml: string;
    try {
      contractYaml = await clawContractManager.readContractYamlRaw(contractId);
    } catch (e) {
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.RETRO_YAML_FAILED,
        `contractId=${contractId}`,
        `err=${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    // 2.2 加载 dispatch-skills（best-effort 退化）
    let skillsSummary = '';
    try {
      const reg = createSkillRegistry(ctx.motionFs, 'clawspace/dispatch-skills');
      await reg.loadAll();
      const formatted = reg.formatForContext();
      if (!formatted.includes('No skills loaded')) {
        skillsSummary = formatted;
      }
    } catch (e) {
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.RETRO_SKILL_FAILED,
        `err=${e instanceof Error ? e.message : String(e)}`,
      );
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
          this.auditWriter?.write(
            CONTRACT_AUDIT_EVENTS.RETRO_MINING_FAILED,
            `taskId=${miningTaskId}`,
            'reason=ENOENT',
          );
        } else {
          this.auditWriter?.write(
            CONTRACT_AUDIT_EVENTS.RETRO_MINING_FAILED,
            `taskId=${miningTaskId}`,
            `err=${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // best-effort：加载失败退化为空上下文
      }
    }

    // Part 3: buildRetroPrompt + writePending + cleanup（daemon.ts:215-238 等价）

    // 3.1 构建复盘 prompt + retroMessages
    const retroPrompt = buildRetroPrompt(targetClaw, contractId, contractYaml, skillsSummary);
    const retroMessages: Message[] = [...baseMessages, { role: 'user', content: retroPrompt }];

    // 3.2 调度复盘子代理（writePending 失败不清 by-contract 留重试）
    try {
      await writePendingSubagentTaskFile(ctx.motionFs, ctx.motionAudit, {
        kind: 'subagent',
        prompt: '',
        messages: retroMessages,
        tools: ['read', 'write', 'skill', 'exec'],
        timeout: 600,
        maxSteps: DEFAULT_MAX_STEPS,
        idleTimeoutMs: DEFAULT_LLM_IDLE_TIMEOUT_MS,
        parentClawId: 'motion',
        originClawId: 'motion',
      });
    } catch (e) {
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.RETRO_SCHEDULE_FAILED,
        `err=${e instanceof Error ? e.message : String(e)}`,
      );
      return;  // 不清 by-contract，留待下次 daemon 重启重试
    }

    // 3.3 调度成功后 cleanup by-contract 索引（best-effort）
    await fsAsync.unlink(byContractPath).catch(e =>
      this.auditWriter?.write(
        CONTRACT_AUDIT_EVENTS.RETRO_CLEANUP_FAILED,
        `err=${e instanceof Error ? e.message : String(e)}`,
      )
    );
  }

}
