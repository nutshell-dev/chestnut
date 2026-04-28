/**
 * TaskSystem - SubAgent task lifecycle management
 * 
 * Manages subagent task queue and execution using directory-based persistence.
 * Uses a pending queue + dispatcher pattern for concurrency control.
 */

import { randomUUID } from 'crypto';
import * as path from 'path';

import type { FileSystem } from '../../foundation/fs/types.js';

import { DEFAULT_MAX_CONCURRENT_TASKS } from '../../constants.js';
import { ToolRegistryImpl } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/builtins/index.js';
import type { LLMService } from '../../foundation/llm/index.js';
import type { CallerType } from '../tools/caller-type.js';

import type { ToolResult, Tool } from '../tools/executor.js';
import type { Message, ToolDefinition } from '../../types/message.js';
import type { OutboxWriter } from '../../foundation/messaging/index.js';
import type { ContractManager } from '../contract/manager.js';
import { AuditWriter } from '../../foundation/audit/writer.js';
import { TASKS_RUNNING_DIR, TASKS_DONE_DIR } from '../../types/paths.js';
import type { StreamLog } from '../../foundation/stream/types.js';

import { TASKS_PENDING_DIR } from '../../types/paths.js';
import { sendFallbackError } from './result-delivery.js';
import { recoverTasks } from './task-recovery.js';
import { executeSubAgentTask } from './subagent-executor.js';
import { executeToolTask } from './tool-executor.js';
import { createWatcher, type Watcher } from '../../foundation/file-watcher/index.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';

export interface TaskSystemOptions {
  maxConcurrent?: number;
  auditWriter: AuditWriter;
  retryBaseDelayMs?: number;
  parentStreamLog?: StreamLog;

  // phase155C 新增（4 个原 setter 合入 ctor）
  llm: LLMService;
  contractManager: ContractManager;
  outboxWriter: OutboxWriter;
}


export interface SubAgentTask {
  kind: 'subagent';
  id: string;
  prompt: string;
  tools: string[];
  timeout: number;
  maxSteps: number;
  parentClawId: string;
  createdAt: string;
  systemPrompt?: string;                    // dispatcher 用 Motion 的 system prompt
  callerType?: CallerType;
  idleTimeoutMs?: number;                  // LLM 静默超时阈值（用户可配置）
  messages?: Message[];                    // 若提供，SubAgent 直接用；否则从 prompt 构建
  originClawId?: string;                   // 创建链路源头，传给子 SubAgent
  toolsForLLM?: ToolDefinition[];          // 若提供，直接用；否则从 registry 计算
  extraTools?: Tool[];                    // per-task 额外工具，不污染全局 registry
}

export interface ToolTask {
  kind: 'tool';
  id: string;
  toolName: string;
  parentClawId: string;
  createdAt: string;
  isIdempotent: boolean;  // Determines if retry is allowed
  maxRetries: number;     // Max retry attempts (default 2)
  retryCount: number;     // Current retry count (initial 0)
  callerType?: CallerType;  // 决定 inbox 消息 from 字段
  toolUseId?: string;   // 对应 LLM tool_use block id，用于 tool_async_result
}

interface TaskState {
  abortController: AbortController;
  promise: Promise<void>;
}

export class TaskSystem {
  private runningTasks: Map<string, TaskState> = new Map();
  private maxConcurrent: number;
  private registry: ToolRegistryImpl;
  private readonly llm: LLMService;
  private readonly contractManager: ContractManager;
  private readonly outboxWriter: OutboxWriter;
  private auditWriter: AuditWriter;
  private parentStreamLog?: StreamLog;
  private pendingWatcher?: Watcher;

  // Task result handlers (array for concurrent dispatch support)
  private _taskResultHandlers: Array<
    (taskId: string, callerType: CallerType | undefined, result: string, isError: boolean) => Promise<string>
  > = [];

  /**
   * Register a result handler. Returns a cleanup function to deregister.
   * Handlers are called in registration order; each receives the result
   * returned by the previous handler (pipeline pattern).
   */
  addTaskResultHandler(
    handler: (taskId: string, callerType: CallerType | undefined, result: string, isError: boolean) => Promise<string>,
  ): () => void {
    this._taskResultHandlers.push(handler);
    return () => {
      const idx = this._taskResultHandlers.indexOf(handler);
      if (idx >= 0) this._taskResultHandlers.splice(idx, 1);
    };
  }
  
  // Transient dispatch buffer; subagent file persistence is authoritative,
  // tool tasks still use this as entry point
  private pendingQueue: Array<SubAgentTask | ToolTask> = [];

  // Store tool callbacks separately (not serializable to disk)
  private pendingCallbacks: Map<string, () => Promise<ToolResult>> = new Map();
  private retryBaseDelayMs: number;

  constructor(
    private clawDir: string,
    private fs: FileSystem,
    options: TaskSystemOptions,
  ) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.auditWriter = options.auditWriter;
    this.parentStreamLog = options.parentStreamLog;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.llm = options.llm;
    this.contractManager = options.contractManager;
    this.outboxWriter = options.outboxWriter;
    // Create tool registry for subagents
    this.registry = new ToolRegistryImpl();
    registerBuiltinTools(this.registry);
  }

  async initialize(): Promise<void> {
    // Ensure task directories exist
    await this.fs.ensureDir(TASKS_PENDING_DIR);
    await this.fs.ensureDir(TASKS_RUNNING_DIR);
    await this.fs.ensureDir(TASKS_DONE_DIR);
    await this.fs.ensureDir('tasks/failed');
    await this.fs.ensureDir('tasks/results');

    // Cold-start recovery: load existing pending and running tasks
    await recoverTasks({ fs: this.fs, auditWriter: this.auditWriter, pendingQueue: this.pendingQueue });
  }

  /**
   * Start dispatching pending tasks.
   * The LLM service is injected via constructor; dispatch is ready once
   * initialize() has completed.
   */
  startDispatch(): void {
    // 构造 watcher：add 事件触发 _ingestPendingFile 入队 + dispatch
    // 防御：测试 mock fs 可能缺少 resolve，跳过不影响行为
    if (!this.pendingWatcher && typeof this.fs.resolve === 'function') {
      this.pendingWatcher = createWatcher(
        this.fs.resolve(TASKS_PENDING_DIR),
        (event) => {
          if (event.type !== 'add') return;
          if (!event.path.endsWith('.json')) return;
          void this._ingestPendingFile(event.path);
        },
        {
          stability: 'immediate',
          recursive: false,
          persistent: true,
          onError: (err, context) => {
            const eventType = context === 'callback'
              ? TASK_AUDIT_EVENTS.PENDING_WATCHER_CALLBACK_FAILED
              : TASK_AUDIT_EVENTS.PENDING_WATCHER_FAILED;
            this.auditWriter.write(
              eventType,
              `path=${TASKS_PENDING_DIR}`,
              `context=${context}`,
              `reason=${err.message}`,
            );
          },
        },
      );
    }
    // 启动扫描：把 pending/ 中既有 subagent 文件入队（_ingestPendingFile 内含 _dispatch 触发）
    void this._initialScanPending();
    this._dispatch();
  }

  setParentStreamLog(sink: StreamLog): void {
    this.parentStreamLog = sink;
  }

  private static readonly PENDING_QUEUE_MAX = 1000;

  /**
   * Schedule a new subagent task
   * Returns taskId immediately, task enters pending queue and will be dispatched
   */
  async scheduleSubAgent(taskData: Omit<SubAgentTask, 'id' | 'createdAt'>): Promise<string> {
    const taskId = randomUUID();
    const task: SubAgentTask = {
      ...taskData,
      id: taskId,
      createdAt: new Date().toISOString(),
    };

    // Save to pending directory; watcher will pick up and dispatch
    const taskPath = `${TASKS_PENDING_DIR}/${taskId}.json`;
    await this.fs.writeAtomic(taskPath, JSON.stringify(task, null, 2));

    this.auditWriter?.write('task_scheduled', taskId, 'kind=subagent', `parent=${task.parentClawId}`, `maxSteps=${task.maxSteps}`);

    // No push, no dispatch; watcher ingests asynchronously
    return taskId;
  }

  /**
   * Schedule a new tool task for async execution
   * Returns taskId immediately, task enters pending queue and will be dispatched
   */
  async scheduleTool(
    toolName: string,
    executeCallback: () => Promise<ToolResult>,
    parentClawId: string,
    options?: { isIdempotent?: boolean; maxRetries?: number; callerType?: CallerType; toolUseId?: string }
  ): Promise<string> {
    const taskId = randomUUID();
    const isIdempotent = options?.isIdempotent ?? false;
    const task: ToolTask = {
      kind: 'tool',
      id: taskId,
      toolName,
      parentClawId,
      createdAt: new Date().toISOString(),
      isIdempotent,
      maxRetries: isIdempotent ? (options?.maxRetries ?? 2) : 0,
      retryCount: 0,
      callerType: options?.callerType,
      toolUseId: options?.toolUseId,
    };

    // Save to pending directory before registering in memory
    const taskPath = `${TASKS_PENDING_DIR}/${taskId}.json`;
    await this.fs.writeAtomic(taskPath, JSON.stringify(task, null, 2));

    // Guard: check queue capacity before registering callback
    if (this.pendingQueue.length >= TaskSystem.PENDING_QUEUE_MAX) {
      throw new Error(`pendingQueue full (${TaskSystem.PENDING_QUEUE_MAX} tasks pending)`);
    }

    // Register callback only after file write succeeds and queue capacity confirmed
    this.pendingCallbacks.set(taskId, executeCallback);
    this.pendingQueue.push(task);

    this.auditWriter?.write('task_scheduled', taskId, 'kind=tool', `parent=${parentClawId}`, `tool=${toolName}`, `queue=${this.pendingQueue.length}`);

    // Trigger dispatch
    this._dispatch();

    return taskId;
  }

  /**
   * Startup scan: ingest all existing pending files through the same path
   * as the watcher. Called by recoverTasks after filesystem cleanup.
   */
  private async _initialScanPending(): Promise<void> {
    const entries = await this.fs.list(TASKS_PENDING_DIR);
    for (const entry of entries) {
      if (entry.name.endsWith('.json')) {
        await this._ingestPendingFile(entry.path);
      }
    }
  }

  /**
   * Ingest a single pending file: read, parse, dedupe, push, dispatch.
   * Shared by watcher callback and _initialScanPending.
   */
  private async _ingestPendingFile(filePath: string): Promise<void> {
    let taskId: string | undefined;
    try {
      const fileName = path.basename(filePath, '.json');
      taskId = fileName;
      if (this.runningTasks.has(taskId)) return;
      if (this.pendingQueue.some(t => t.id === taskId)) return;

      const content = await this.fs.read(filePath);
      const task = JSON.parse(content) as SubAgentTask | ToolTask;
      if (task.kind !== 'subagent') return;

      // task_started stream event triggered here (covers spawn direct write,
      // scheduleSubAgent, and startup recovery scan uniformly)
      this.parentStreamLog?.write({
        ts: Date.now(),
        type: 'task_started',
        taskId,
        callerType: task.callerType ?? 'subagent',
        silent: false,
      });
      this.pendingQueue.push(task);
      this._dispatch();
    } catch (err) {
      this.auditWriter?.write(
        TASK_AUDIT_EVENTS.PENDING_INGEST_FAILED,
        taskId ?? '<unknown>',
        `path=${filePath}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Dispatch pending tasks to running state
   * This is the core dispatcher that manages concurrency
   * 
   * CRITICAL: Must immediately occupy slot in runningTasks before any async
   * operation to prevent race conditions where _dispatch is called again.
   */
  private _dispatch(): void {
    // While we have capacity and pending tasks, move them to running
    while (this.runningTasks.size < this.maxConcurrent && this.pendingQueue.length > 0) {
      const task = this.pendingQueue.shift();
      if (!task) break;

      const abortController = new AbortController();

      // Start the task (this will handle file move + execution)
      const promise = this._startTask(task, abortController.signal);

      // IMMEDIATELY occupy slot - critical to prevent race conditions
      this.runningTasks.set(task.id, { abortController, promise });
    }
  }

  /**
   * Start a task: move from pending to running, then execute
   */
  private async _startTask(
    task: SubAgentTask | ToolTask,
    signal: AbortSignal
  ): Promise<void> {
    try {
      // Move file from pending to running (async operation)
      await this.movePendingToRunning(task.id);
      
      // Execute the task
      if (task.kind === 'tool') {
        const callback = this.pendingCallbacks.get(task.id);
        this.pendingCallbacks.delete(task.id); // Clean up
        if (!callback) {
          throw new Error(`Tool task ${task.id} (${(task as ToolTask).toolName}) missing callback — cannot execute`);
        }
        await executeToolTask(task, callback, signal, {
          fs: this.fs,
          auditWriter: this.auditWriter,
          retryBaseDelayMs: this.retryBaseDelayMs,
          moveTaskToDone: this.moveTaskToDone.bind(this),
          moveTaskToFailed: this.moveTaskToFailed.bind(this),
        });
      } else {
        await executeSubAgentTask(task, signal, {
          fs: this.fs,
          auditWriter: this.auditWriter,
          llm: this.llm,
          registry: this.registry,
          clawDir: this.clawDir,
          parentStreamLog: this.parentStreamLog,
          taskResultHandlers: this._taskResultHandlers,
          moveTaskToDone: this.moveTaskToDone.bind(this),
          moveTaskToFailed: this.moveTaskToFailed.bind(this),
          taskSystem: this,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.auditWriter?.write(TASK_AUDIT_EVENTS.START_FAILED, task.id, `error=${errorMsg}`);
      // 通知 parent，避免永久挂起
      await sendFallbackError(this.fs, this.auditWriter, task, `Task failed to start: ${errorMsg}`).catch((e) => {
        this.auditWriter?.write(TASK_AUDIT_EVENTS.START_FAILED, task.id, 'context=sendFallbackError', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
      });
      
      // Clean up callback if present
      this.pendingCallbacks.delete(task.id);
    } finally {
      // Remove from running and trigger next dispatch
      this.runningTasks.delete(task.id);
      this._dispatch();
    }
  }

  /**
   * Move task file from pending to running directory
   */
  private async movePendingToRunning(taskId: string): Promise<void> {
    await this.fs.move(
      `${TASKS_PENDING_DIR}/${taskId}.json`,
      `tasks/running/${taskId}.json`
    );
    this.auditWriter?.write('task_started', taskId);
  }

  /**
   * Move task file from running to done
   */
  private async moveTaskToDone(taskId: string): Promise<void> {
    try {
      await this.fs.move(
        `tasks/running/${taskId}.json`,
        `tasks/done/${taskId}.json`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.auditWriter?.write(TASK_AUDIT_EVENTS.MOVE_FAILED, taskId, 'context=move_to_done', `error=${errMsg}`);
      // 删除 running 文件防止重启后重复执行，丢失记录好过重复副作用
      await this.fs.delete(`tasks/running/${taskId}.json`).catch((e) => {
        this.auditWriter?.write(TASK_AUDIT_EVENTS.MOVE_FAILED, taskId, 'context=move_done_delete', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
      });
    }
  }

  private async moveTaskToFailed(taskId: string): Promise<void> {
    try {
      await this.fs.move(
        `tasks/running/${taskId}.json`,
        `tasks/failed/${taskId}.json`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.auditWriter?.write(TASK_AUDIT_EVENTS.MOVE_FAILED, taskId, 'context=move_to_failed', `error=${errMsg}`);
      await this.fs.delete(`tasks/running/${taskId}.json`).catch((e) => {
        this.auditWriter?.write(TASK_AUDIT_EVENTS.MOVE_FAILED, taskId, 'context=move_failed_delete', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
      });
    }
  }

  /**
   * List running task IDs
   */
  listRunning(): string[] {
    return Array.from(this.runningTasks.keys());
  }
  
  /**
   * List pending task IDs.
   *
   * phase163 后语义：仅返回内存中等调度的任务（pendingQueue）；
   * subagent 文件未被 watcher / startDispatch 拾起前不可见。
   * 欲看完整 pending 状态请直读 tasks/pending/ 目录。
   */
  listPending(): string[] {
    return this.pendingQueue.map(task => task.id);
  }

  /**
   * Cancel a running task
   */
  async cancel(taskId: string): Promise<void> {
    // 1. 先检查 running
    const state = this.runningTasks.get(taskId);
    if (state) {
      state.abortController.abort();
      try { await state.promise; } catch {}
      this.auditWriter?.write(TASK_AUDIT_EVENTS.CANCELLED, taskId, 'from=running');
      return;
    }

    // 2. 再检查 pending（内存队列 + 文件系统双源）
    const fileExists = await this.fs.exists(`${TASKS_PENDING_DIR}/${taskId}.json`);
    const queueIdx = this.pendingQueue.findIndex(t => t.id === taskId);

    if (queueIdx === -1 && !fileExists) {
      throw new Error(`Task ${taskId} not found in running or pending`);
    }

    let task: SubAgentTask | ToolTask | undefined =
      queueIdx !== -1 ? this.pendingQueue[queueIdx] : undefined;
    if (queueIdx !== -1) this.pendingQueue.splice(queueIdx, 1);

    // 若仅文件存在（未入队或已 shift），尝试从盘读出以决定是否 sendFallbackError
    if (!task && fileExists) {
      try {
        task = JSON.parse(
          await this.fs.read(`${TASKS_PENDING_DIR}/${taskId}.json`),
        ) as SubAgentTask | ToolTask;
      } catch { /* 无 task 仍可移文件 */ }
    }

    // 清理 tool callback
    this.pendingCallbacks.delete(taskId);

    // 文件：pending → failed
    if (fileExists) {
      await this.fs.move(
        `${TASKS_PENDING_DIR}/${taskId}.json`,
        `tasks/failed/${taskId}.json`
      ).catch((e) => {
        this.auditWriter?.write(TASK_AUDIT_EVENTS.MOVE_FAILED, taskId, 'context=cancel_pending_move', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
      });
    }

    // tool 任务：通知 parent
    if (task?.kind === 'tool') {
      await sendFallbackError(this.fs, this.auditWriter, task, 'Task cancelled before execution').catch((e) => {
        this.auditWriter?.write(TASK_AUDIT_EVENTS.MOVE_FAILED, taskId, 'context=cancel_sendFallbackError', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
      });
    }

    this.auditWriter?.write(TASK_AUDIT_EVENTS.CANCELLED, taskId, 'from=pending');
    return;
  }

  /**
   * Shutdown - wait for all tasks to complete or timeout
   */
  async shutdown(timeoutMs: number = 30000): Promise<void> {
    // 顺序：先关 watcher（避免 shutdown 期间新事件进队）→ 旧 shutdown 流程
    await this.pendingWatcher?.close();
    this.pendingWatcher = undefined;

    // Signal all running tasks to stop
    for (const state of this.runningTasks.values()) {
      state.abortController.abort();
    }

    // Wait for all tasks with timeout
    if (this.runningTasks.size > 0) {
      const promises = Array.from(this.runningTasks.values()).map(s => s.promise);
      await Promise.race([
        Promise.allSettled(promises),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout')), timeoutMs)),
      ]).catch(() => {
        // Timeout is acceptable
        this.auditWriter?.write(TASK_AUDIT_EVENTS.SHUTDOWN_TIMEOUT);
        console.warn('[task] Shutdown timeout, some tasks may not have stopped');
      });
    }

    this.runningTasks.clear();
    this.pendingQueue = [];
    this.pendingCallbacks.clear();
  }
}
