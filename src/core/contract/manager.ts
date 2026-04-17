/**
 * ContractManager - Contract lifecycle management
 *
 * Manages contract loading, progress tracking, acceptance, and status transitions.
 */

// TODO(phase3): Implement contract dependency checks - MVP has check_dependencies() method (contract B starts only after contract A completes)

import * as yaml from 'js-yaml';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fsNative from 'fs';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { Logger } from '../../foundation/monitor/types.js';
import type { ILLMService } from '../../foundation/llm/index.js';
import type { Contract, SubTask, ContractStatus, SubtaskStatus } from '../../types/contract.js';
import { ToolError, ToolTimeoutError } from '../../types/errors.js';
import { exec, execFile } from '../../foundation/process-exec/index.js';
import { ProcessExecError } from '../../foundation/process-exec/index.js';
import { LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_STALE_TIMEOUT_MS, CONTRACT_SCRIPT_TIMEOUT_MS, DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_MAX_STEPS } from '../../constants.js';
import { CONTRACT_VERIFIER_SYSTEM_PROMPT } from '../../prompts/subagent.js';
import { writeInboxMessage } from '../../utils/inbox-writer.js';
import { SubAgent } from '../subagent/agent.js';
import { ToolRegistryImpl } from '../tools/registry.js';
import { ReportResultTool } from '../tools/report-result.js';
import { AuditWriter } from '../../foundation/audit/writer.js';


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
  private monitor?: Logger;
  private llm?: ILLMService;
  private verifierRegistry?: ToolRegistryImpl;
  private activeDir = 'contract/active';
  private pausedDir = 'contract/paused';
  private archiveDir = 'contract/archive';
  private motionInboxDir: string;
  private auditWriter?: AuditWriter;
  onNotify?: (type: string, data: Record<string, unknown>) => void;

  constructor(
    clawDir: string,
    clawId: string,
    fs: FileSystem,
    monitor?: Logger,
    llm?: ILLMService,
    verifierRegistry?: ToolRegistryImpl,
    motionInboxDir?: string,
    auditWriter?: AuditWriter,
  ) {
    this.auditWriter = auditWriter;
    this.clawDir = clawDir;
    this.clawId = clawId;
    this.fs = fs;
    this.monitor = monitor;
    this.llm = llm;
    this.verifierRegistry = verifierRegistry;
    this.motionInboxDir = motionInboxDir ?? path.resolve(clawDir, '..', '..', 'motion', 'inbox', 'pending');
    this.auditWriter = auditWriter;
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
            await fsNative.promises.unlink(absoluteLockPath).catch(() => {});
            continue;
          }
          // 持有者存活但持锁超时：强制清理（防止 bug 导致永久死锁）
          if (Date.now() - time > LOCK_STALE_TIMEOUT_MS) {
            lastReason = `holder PID ${pid} exceeded timeout (${LOCK_STALE_TIMEOUT_MS}ms)`;
            console.warn(`[contract] Lock held too long (> ${LOCK_STALE_TIMEOUT_MS}ms) by PID ${pid}, force clearing`);
            await fsNative.promises.unlink(absoluteLockPath).catch(() => {});
            continue;
          }
          lastReason = `held by PID ${pid} (${Math.round((Date.now() - time) / 1000)}s)`;
        } catch {
          // 读取或解析失败：lock 文件损坏，清理后重试
          lastReason = 'lock file corrupt or unreadable';
          await fsNative.promises.unlink(absoluteLockPath).catch(() => {});
          continue;
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
   * Release the file lock
   */
  private async releaseLock(lockPath: string): Promise<void> {
    try {
      await this.fs.delete(lockPath);
    } catch (e) {
      // Ignore deletion failure (may have already been cleaned up by another process)
      this.monitor?.log('error', {
        context: 'ContractManager.releaseLock',
        lockPath,
        error: e instanceof Error ? e.message : String(e),
      });
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
          console.warn(`[contract] progress.json corrupted: ${entry.name}`, error);
          if (this.monitor) {
            this.monitor.log('error', {
              context: 'ContractManager.loadActive',
              contract: entry.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
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
          console.warn(`[contract] progress.json corrupted: ${entry.name}`, error);
          this.monitor?.log('error', {
            context: 'ContractManager.loadPaused',
            contract: entry.name,
            error: error instanceof Error ? error.message : String(error),
          });
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
      console.log(`[contract] Archiving existing contract ${existing.id} for new contract ${contractId}`);
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
        console.warn(`[contract] Failed to rollback contract dir for ${contractId}: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`);
      });
      throw err;
    }

    try {
      this.onNotify?.('contract_created', { contractId, title: contractYaml.title, subtaskCount: contractYaml.subtasks.length });
    } catch (err) {
      console.warn('[contract] onNotify error:', err instanceof Error ? err.message : String(err));
    }
    this.auditWriter?.write('contract_created', contractId, `subtasks=${contractYaml.subtasks.length}`, `title=${contractYaml.title}`);
    // 保留原有：
    this.monitor?.log('contract_created', { contractId });
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
      
      this.monitor?.log('contract_acceptance_started', {
        contractId,
        subtaskId,
      });
    });

    // Start background acceptance (fire-and-forget)
    this._runAcceptanceInBackground(params, contractYaml, acceptanceConfig)
      .catch(err => {
        this.monitor?.log('error', {
          context: 'ContractManager.backgroundAcceptance',
          contractId,
          subtaskId,
          error: err instanceof Error ? err.message : String(err),
        });
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
        this.monitor?.log('error', {
          context: 'ContractManager._completeSubtaskSync',
          contractId,
          subtaskId,
          message: 'Unknown subtaskId',
        });
        return;
      }

      // Guard: skip if acceptance already running or subtask already completed
      const currentStatus = progress.subtasks[subtaskId].status;
      if (currentStatus === 'in_progress') {
        result = { passed: false, feedback: `Subtask "${subtaskId}" acceptance is already in progress — duplicate done() call ignored.` };
        this.monitor?.log('warn', {
          context: 'ContractManager._completeSubtaskSync',
          contractId,
          subtaskId,
          message: 'Duplicate done() call ignored - acceptance in progress',
        });
        return;
      }
      if (currentStatus === 'completed') {
        result = { passed: false, feedback: `Subtask "${subtaskId}" is already completed.` };
        this.monitor?.log('warn', {
          context: 'ContractManager._completeSubtaskSync',
          contractId,
          subtaskId,
          message: 'Subtask already completed',
        });
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
        console.warn('[contract] onNotify error:', err instanceof Error ? err.message : String(err));
      }
      const subtaskTotal = contractYaml.subtasks.length;
      const completedCount = Object.values(progress.subtasks).filter(s => s.status === 'completed').length;
      this._notifyMotionStream('subtask_completed', { contractId, subtaskId, clawId: this.clawId, completedCount, subtaskTotal });

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
      
      this.monitor?.log('contract_updated', {
        contractId,
        subtaskId,
        status: allCompleted ? 'completed' : 'running',
      });
    });

    // Archive and notify Motion outside the lock (best-effort)
    if (allCompleted) {
      const title = contractYaml.title;
      try {
        await this.moveToArchive(contractId);
        this.notifyMotionCompletion(contractId, title);
      } catch (err) {
        console.error('[contract] moveToArchive failed, skipping completion notification:', err);
        this.monitor?.log('error', {
          context: 'ContractManager._completeSubtaskSync',
          contractId,
          message: 'moveToArchive failed; contract stays in active/',
          error: err instanceof Error ? err.message : String(err),
        });
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
        this.monitor?.log('error', {
          context: 'ContractManager._runAcceptanceInBackground',
          contractId,
          subtaskId,
          message: 'acceptance config missing script_file',
        });
      } else {
        result = await this.runScriptAcceptance(scriptFile, contractAbsDir);
      }
    } else {
      const promptFile = acceptanceConfig.prompt_file;
      if (!promptFile) {
        result = { passed: false, feedback: 'acceptance config llm 类型缺少 prompt_file' };
        this.monitor?.log('error', {
          context: 'ContractManager._runAcceptanceInBackground',
          contractId,
          subtaskId,
          message: 'acceptance config missing prompt_file',
        });
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
        this.monitor?.log('error', {
          context: 'ContractManager._runAcceptanceInBackground',
          contractId,
          subtaskId,
          error: 'subtask missing from progress after in_progress mark',
        });
        return;
      }
      
      if (result.passed) {
        // Mark completed
        subtask.status = 'completed';
        subtask.completed_at = new Date().toISOString();
        try {
          this.onNotify?.('subtask_completed', { contractId, subtaskId });
        } catch (err) {
          console.warn('[contract] onNotify error:', err instanceof Error ? err.message : String(err));
        }
          const subtaskTotal = contractYaml.subtasks.length;
        const completedCount = Object.values(progress.subtasks).filter(s => s.status === 'completed').length;
        this._notifyMotionStream('subtask_completed', { contractId, subtaskId, clawId: this.clawId, completedCount, subtaskTotal });

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
        
        // Notify Motion if all completed
        if (allCompleted) {
          try {
            await this.moveToArchive(contractId);
            this.notifyMotionCompletion(contractId, contractYaml.title);
          } catch (err) {
            console.error('[contract] moveToArchive failed, skipping completion notification:', err);
            this.monitor?.log('error', {
              context: 'ContractManager._runAcceptanceInBackground',
              contractId,
              message: 'moveToArchive failed; contract stays in active/',
              error: err instanceof Error ? err.message : String(err),
            });
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
          console.warn('[contract] onNotify error:', err instanceof Error ? err.message : String(err));
        }
          this._notifyMotionStream('acceptance_failed', { contractId, subtaskId, feedback: result.feedback, clawId: this.clawId });

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
          this.notifyMotionEscalation(contractId, subtaskId, result.feedback, subtask.retry_count);
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

    writeInboxMessage(this.fs, {
      inboxDir: path.join(this.clawDir, 'inbox', 'pending'),
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
      writeInboxMessage(this.fs, {
        inboxDir: path.join(this.clawDir, 'inbox', 'pending'),
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
      console.error('[contract] Failed to write acceptance error to inbox:', e);
      this.monitor?.log('error', {
        context: 'ContractManager._writeAcceptanceError',
        contractId,
        subtaskId,
        error: e instanceof Error ? e.message : String(e),
      });
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
      console.error('[contract] Failed to reset subtask status after acceptance error:', e);
      this.monitor?.log('error', {
        context: 'ContractManager._writeAcceptanceError.resetStatus',
        contractId,
        subtaskId,
        error: e instanceof Error ? e.message : String(e),
      });
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
   * Notify Motion of subtask escalation (too many retries)
   */
  private notifyMotionEscalation(
    contractId: string,
    subtaskId: string,
    lastFeedback: string,
    retryCount: number,
  ): void {
    try {
      const motionInbox = this.motionInboxDir;

      writeInboxMessage(this.fs, {
        inboxDir: motionInbox,
        type: 'contract_escalation',
        source: this.clawId,
        priority: 'high',
        extraFields: {
          contract_id: contractId,
          subtask_id: subtaskId,
          retry_count: String(retryCount),
        },
        body: `Subtask "${subtaskId}" has failed ${retryCount} times.\n\nLast feedback:\n${lastFeedback}`,
      });
    } catch (e) {
      this.monitor?.log('error', {
        context: 'ContractManager.notifyMotionEscalation',
        contractId,
        subtaskId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Notify Motion of LLM acceptance timeout
   */
  private notifyMotionAcceptanceTimeout(contractId: string, subtaskId: string): void {
    try {
      const motionInbox = this.motionInboxDir;

      writeInboxMessage(this.fs, {
        inboxDir: motionInbox,
        type: 'acceptance_timeout',
        source: this.clawId,
        priority: 'high',
        extraFields: { contract_id: contractId, subtask_id: subtaskId },
        body: `LLM acceptance verifier timed out for subtask "${subtaskId}".`,
      });
    } catch (e) {
      this.monitor?.log('error', {
        context: 'ContractManager.notifyMotionAcceptanceTimeout',
        contractId,
        subtaskId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
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

    console.log(`[contract] Running acceptance script: ${scriptFile} (cwd: ${this.clawDir})`);

    try {
      await execFile(resolved, [], {
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

      // Build verifier registry: existing tools + report_result tool
      const reportTool = new ReportResultTool();
      const registry = new ToolRegistryImpl();
      for (const t of (this.verifierRegistry ?? new ToolRegistryImpl()).getAll()) {
        registry.register(t);
      }
      registry.register(reportTool);

      // Create SubAgent for verification
      const agent = new SubAgent({
        agentId: `verifier-${contractId}-${subtaskId}`,
        prompt: filledPrompt,
        clawDir: this.clawDir,
        llm: this.llm,
        registry,
        fs: this.fs as any,
        maxSteps: DEFAULT_MAX_STEPS,
        idleTimeoutMs: DEFAULT_LLM_IDLE_TIMEOUT_MS,
        onIdleTimeout: () => this.notifyMotionAcceptanceTimeout(contractId, subtaskId),
        systemPrompt: CONTRACT_VERIFIER_SYSTEM_PROMPT,
      });

      // Run verification
      const text = await agent.run();

      // Prefer structured tool call result (guaranteed valid JSON via native tool calling)
      if (reportTool.capturedResult) {
        return {
          passed: reportTool.capturedResult.passed,
          feedback: JSON.stringify(reportTool.capturedResult),
          structured: reportTool.capturedResult,
        };
      }

      // Fallback: text-based JSON parsing (backward compat with old prompt files)
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { passed: false, feedback: `LLM 返回格式错误: 无法解析 JSON — ${text}` };
      }

      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const result = JSON.parse(jsonStr) as { passed: boolean; reason: string; issues?: string[] };

      return {
        passed: result.passed,
        feedback: jsonStr,
        structured: result,
      };
    } catch (err) {
      if (err instanceof ToolTimeoutError) {
        return { passed: false, feedback: '验收子代理超时' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { passed: false, feedback: `LLM 验收失败: ${msg}` };
    }
  }

  /**
   * Notify Motion of contract completion (best-effort with retry)
   */
  private notifyMotionCompletion(contractId: string, contractTitle: string): void {
    
    const opts = {
      inboxDir: this.motionInboxDir,
      type: 'review_request' as const,
      source: this.clawId,
      priority: 'low' as const,
      extraFields: { claw_id: this.clawId, contract_id: contractId },
      body: `[system] Contract "${contractTitle}" (${contractId}) completed by ${this.clawId}.`,
    };

    try {
      writeInboxMessage(this.fs, opts);
    } catch (e) {
      // 瞬时失败：500ms 后重试一次
      setTimeout(() => {
        try {
          writeInboxMessage(this.fs, opts);
          this.monitor?.log('system', {
            context: 'ContractManager.notifyMotionCompletion',
            contractId,
            note: 'retry succeeded',
          });
        } catch (e2) {
          this.monitor?.log('error', {
            context: 'ContractManager.notifyMotionCompletion',
            contractId,
            error: e2 instanceof Error ? e2.message : String(e2),
            note: 'retry also failed, review_request not delivered',
          });
        }
      }, 500);
    }
  }

  /**
   * Directly write user_notify to Motion stream.jsonl (cross-server best-effort)
   */
  private _notifyMotionStream(subtype: string, data: Record<string, unknown>): void {
    const motionDir = path.resolve(this.motionInboxDir, '..', '..');
    const streamPath = path.join(motionDir, 'stream.jsonl');
    const line = JSON.stringify({ ts: Date.now(), type: 'user_notify', subtype, ...data }) + '\n';
    fsNative.promises.mkdir(motionDir, { recursive: true })
      .then(() => fsNative.promises.appendFile(streamPath, line))
      .catch((e: any) => {
        console.warn(`[contract] _notifyMotionStream failed (${e?.code}): ${e?.message}`);
      });
  }
}
