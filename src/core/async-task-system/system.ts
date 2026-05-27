/**
 * AsyncTaskSystem - SubAgent task lifecycle management
 * 
 * Manages subagent task queue and execution using directory-based persistence.
 * Uses a pending queue + dispatcher pattern for concurrency control.
 */

import { randomUUID } from 'crypto';
import { MOTION_CLAW_ID } from '../../constants.js';
import { CALLER_TYPE_TO_GROUPS } from '../caller-types.js';
import * as path from 'path';

import type { PermissionChecker } from '../../foundation/tool-protocol/permission.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

import { DEFAULT_MAX_CONCURRENT_TASKS, SHUTDOWN_DRAIN_GRACE_MS, DEFAULT_RETRY_BASE_DELAY_MS, PENDING_QUEUE_MAX } from './constants.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { InboxWriter } from '../../foundation/messaging/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SYNC_DIR,
} from './dirs.js';
import { CLAWSPACE_DIR } from '../../foundation/paths.js';
import type { StreamLog } from '../../foundation/stream/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import type { Tool } from '../../foundation/tools/index.js';
import { sendFallbackError } from './result-delivery.js';
import { recoverTasks } from './task-recovery.js';
import { validateTaskShape, backupCorruptTask } from './task-corrupt-helpers.js';
import { executeSubAgentTask } from './subagent-executor.js';
import { executeToolTask } from './tool-executor.js';
import { createWatcher, type Watcher } from '../../foundation/file-watcher/index.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { STREAM_TASK_EVENTS } from './stream-events.js';
import { formatErr } from './_helpers.js';
import {
  emitTaskScheduled,
  emitTaskStarted,
  emitPendingIngestFailed,
  emitPendingQueueOverflow,
  emitPendingQueueOverflowNotified,
  emitPendingWatcherFailed,
  emitRecoveryFailed,
  emitStartFailed,
  emitMoveFailed,
  emitCancelPromiseRejected,
  emitCancelled,
  emitTaskCancelRaceLostToDispatch,
  emitParseFailed,
  emitShutdownTimeout,
  emitShutdownPendingCleanupsDrained,
} from './audit-emit.js';
import type { PostProcessor } from './post-processors/types.js';
import type { AsyncTaskSystemOptions, SubAgentTask, ToolTask } from './types.js';
import { type TaskId, makeTaskId } from '../../foundation/identity/index.js';
import { type ClawDir, makeClawDir } from '../../foundation/identity/index.js';



interface TaskState {
  abortController: AbortController;
  promise: Promise<void>;
}

export class AsyncTaskSystem {
  private runningTasks: Map<string, TaskState> = new Map();
  private readonly maxConcurrent: number;
  private readonly registry: ToolRegistry;
  private readonly llm: LLMOrchestrator;
  private readonly motionInbox?: InboxWriter;
  private auditWriter: AuditLog;
  private parentStreamLog?: StreamLog;
  private pendingWatcher?: Watcher;
  private mainDialogStore?: DialogStore;

  private postProcessors: Map<string, PostProcessor> = new Map();
  private cancellingIds: Set<string> = new Set();
  private readonly toolTimeoutMs?: number;
  private permissionChecker?: PermissionChecker;
  private fsFactory: (baseDir: string) => FileSystem;
  private readonly askMotionToolFactory: (llm: LLMOrchestrator, motionDialogStore: DialogStore) => Tool;
  private _shuttingDown = false;

  /**
   * 装配期注册 PostProcessor
   * 应然：name 唯一 / handler 是 standalone function / 0 closure / 0 跨 task state
   */
  addPostProcessor(name: string, handler: PostProcessor): void {
    if (this.postProcessors.has(name)) {
      throw new Error(`PostProcessor "${name}" already registered`);
    }
    this.postProcessors.set(name, handler);
  }

  /**
   * inject mainDialogStore after construction (sessionManager is created later in Assembly)
   */
  setMainDialogStore(store: DialogStore): void {
    this.mainDialogStore = store;
  }
  
  // Transient dispatch buffer; subagent file persistence is authoritative,
  // tool tasks still use this as entry point
  private pendingQueue: Array<SubAgentTask | ToolTask> = [];

  private readonly retryBaseDelayMs: number;

  constructor(
    private readonly clawDir: ClawDir,
    private readonly fs: FileSystem,
    options: AsyncTaskSystemOptions,
  ) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.auditWriter = options.auditWriter;
    this.parentStreamLog = options.parentStreamLog;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.llm = options.llm;
    this.motionInbox = options.motionInbox;
    this.mainDialogStore = options.mainDialogStore;
    this.registry = options.registry;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.permissionChecker = options.permissionChecker;
    this.fsFactory = options.fsFactory;
    this.askMotionToolFactory = options.askMotionToolFactory;
  }

  async initialize(): Promise<void> {
    // Ensure task directories exist
    await this.fs.ensureDir(TASKS_QUEUES_PENDING_DIR);
    await this.fs.ensureDir(TASKS_QUEUES_RUNNING_DIR);
    await this.fs.ensureDir(TASKS_QUEUES_DONE_DIR);
    await this.fs.ensureDir(TASKS_QUEUES_FAILED_DIR);
    await this.fs.ensureDir(TASKS_QUEUES_RESULTS_DIR);

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
        this.fs.resolve(TASKS_QUEUES_PENDING_DIR),
        (event) => {
          if (event.type !== 'add') return;
          if (!event.path.endsWith('.json')) return;
          this._ingestPendingFile(event.path).catch((err) => {
            emitPendingIngestFailed(
              this.auditWriter,
              {
                context: 'watcher_async',
                path: event.path,
                error: formatErr(err),
              },
            );
          });
        },
        {
          stability: 'immediate',
          recursive: false,
          persistent: true,
          onError: (err, context) => {
            const eventType = context === 'callback'
              ? TASK_AUDIT_EVENTS.PENDING_WATCHER_CALLBACK_FAILED
              : TASK_AUDIT_EVENTS.PENDING_WATCHER_FAILED;
            emitPendingWatcherFailed(
              this.auditWriter,
              {
                event: eventType,
                path: TASKS_QUEUES_PENDING_DIR,
                context,
                reason: err.message,
              },
            );
          },
        },
      );
    }
    // 启动扫描：把 pending/ 中既有 subagent 文件入队（_ingestPendingFile 内含 _dispatch 触发）
    void this._initialScanPending().catch((err) => {
      emitRecoveryFailed(
        this.auditWriter,
        {
          source: 'system',
          context: 'initial_scan_pending_failed',
          error: formatErr(err),
        },
      );
    });
    this._dispatch();
  }

  setParentStreamLog(sink: StreamLog): void {
    this.parentStreamLog = sink;
  }

  /**
   * Schedule a new subagent task
   * Returns taskId immediately, task enters pending queue and will be dispatched
   */
  async scheduleSubAgent(taskData: Omit<SubAgentTask, 'id' | 'createdAt'>): Promise<string> {
    return this.schedule('subagent', taskData);
  }

  /**
   * Semantic scheduling API (phase 1332 N2).
   * Replaces cross-L4 writePendingSubagentTaskFile leak.
   */
  async schedule(
    taskKind: 'subagent',
    payload: Omit<SubAgentTask, 'id' | 'createdAt'>,
  ): Promise<string> {
    const taskId = makeTaskId(randomUUID());
    const task = {
      ...payload,
      id: taskId,
      createdAt: new Date().toISOString(),
    } as SubAgentTask;

    // Save to pending directory; watcher will pick up and dispatch
    const taskPath = `${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`;
    await this.fs.writeAtomic(taskPath, JSON.stringify(task, null, 2));

    emitTaskScheduled(this.auditWriter, {
      taskId,
      kind: taskKind,
      parent: task.parentClawId,
      maxSteps: task.maxSteps,
    });

    // No push, no dispatch; watcher ingests asynchronously
    return taskId;
  }



  /**
   * Startup scan: ingest all existing pending files through the same path
   * as the watcher. Called by recoverTasks after filesystem cleanup.
   */
  private async _initialScanPending(): Promise<void> {
    const entries = await this.fs.list(TASKS_QUEUES_PENDING_DIR);
    for (const entry of entries) {
      if (entry.name.endsWith('.json')) {
        await this._ingestPendingFile(entry.path);
      }
    }
  }

  /**
   * Sync dedup gate: check if taskId already exists in running, cancelling, or pending.
   */
  private _isDuplicate(taskId: TaskId): boolean {
    return this.runningTasks.has(taskId)
        || this.cancellingIds.has(taskId)
        || this.pendingQueue.some(t => t.id === taskId);
  }

  /**
   * Async load + parse a pending task file. Returns null if kind is invalid.
   */
  private async _loadPendingTask(filePath: string): Promise<SubAgentTask | ToolTask | null> {
    const content = await this.fs.read(filePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      await backupCorruptTask(this.fs, this.auditWriter, filePath, content, e);
      return null;
    }
    if (!validateTaskShape(parsed)) {
      await backupCorruptTask(this.fs, this.auditWriter, filePath, content, new Error('shape_mismatch'));
      return null;
    }
    return parsed;
  }

  /**
   * Enqueue a validated task (with cap check) and trigger dispatch.
   * If pending queue is at max capacity, audit overflow and move file to failed/.
   */
  private async _enqueueAndDispatch(task: SubAgentTask | ToolTask): Promise<void> {
    // T6: PENDING_QUEUE_MAX cap check
    if (this.pendingQueue.length >= PENDING_QUEUE_MAX) {
      emitPendingQueueOverflow(this.auditWriter, {
        taskId: task.id,
        queueLength: this.pendingQueue.length,
        cap: PENDING_QUEUE_MAX,
      });
      // Move file to failed/ to prevent restart watcher race re-ingest
      const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
      const failedPath = `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`;
      await this.fs.move(pendingPath, failedPath).catch((moveErr) => {
        emitMoveFailed(this.auditWriter, {
          taskId: task.id,
          context: 'cap_overflow_move',
          error: formatErr(moveErr),
        });
      });

      // Notify motion of overflow rejection (best-effort)
      if (this.motionInbox) {
        try {
          this.motionInbox.writeSync({
            type: 'task_queue_overflow',
            source: 'async-task-system',
            priority: 'critical',
            body: `Task ${task.id} (${task.kind}) rejected: queue at cap ${PENDING_QUEUE_MAX}`,
            idPrefix: `${Date.now()}_overflow`,
          });
          emitPendingQueueOverflowNotified(this.auditWriter, {
            taskId: task.id,
            queueLength: this.pendingQueue.length,
            cap: PENDING_QUEUE_MAX,
          });
        } catch (notifyErr) {
          emitMoveFailed(this.auditWriter, {
            taskId: task.id,
            context: 'overflow_notify_failed',
            error: formatErr(notifyErr),
          });
        }
      }

      return;
    }

    // task_started: SubAgentTask emitted in executeSubAgentTask after dir creation;
    // ToolTask emitted here (no per-task result dir / no stream reader needed)
    if (task.kind === 'tool') {
      this.parentStreamLog?.write({
        ts: Date.now(),
        type: STREAM_TASK_EVENTS.TASK_STARTED,
        taskId: task.id,
        callerType: task.callerType ?? 'subagent',
        silent: false,
      });
    }
    this.pendingQueue.push(task);
    this._dispatch();
  }

  /**
   * Ingest a single pending file: read, parse, dedupe, push, dispatch.
   * Shared by watcher callback and _initialScanPending.
   */
  private async _ingestPendingFile(filePath: string): Promise<void> {
    let taskId: TaskId | undefined;
    try {
      taskId = makeTaskId(path.basename(filePath, '.json'));
      if (!taskId || this._isDuplicate(taskId)) return;

      const task = await this._loadPendingTask(filePath);
      if (!task) return;

      // β race fix (phase 556 + phase 612): concurrent ingest 同 taskId 可
      // 在 _loadPendingTask await 间隙双通过 sync gate / cancel 也可 race ahead.
      // 升级三 set 全 re-check (runningTasks + cancellingIds + pendingQueue) 防：
      // (a) cancel 期间 ghost dispatch (phase 556 β)
      // (b) concurrent ingest 双 push 同 taskId (phase 612 P1.7)
      // (c) 上次 ingest 已 push 但本次 await 慢于其
      if (!taskId || this._isDuplicate(taskId)) return;

      await this._enqueueAndDispatch(task);
    } catch (err) {
      emitPendingIngestFailed(this.auditWriter, {
        taskId: taskId ?? '<unknown>',
        path: filePath,
        error: formatErr(err),
      });
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
    if (this._shuttingDown) return;
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
        const tool = this.registry.getAll().find(t => t.name === task.toolName);
        if (!tool) {
          await this.fs.delete(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`).catch((err) => {
            this.auditWriter?.write(
              TASK_AUDIT_EVENTS.RUNNING_FILE_DELETE_FAILED,
              `task_id=${task.id}`,
              `reason=${err instanceof Error ? err.message : String(err)}`,
            );
          });
          throw new Error(`Tool "${task.toolName}" not found in registry`);
        }
        const reconstructedCtx = this.buildToolTaskExecContext(task, signal);
        const callback = () => tool.execute(task.args, reconstructedCtx);
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
          fsFactory: this.fsFactory,
          auditWriter: this.auditWriter,
          llm: this.llm,
          registry: this.registry,
          clawDir: this.clawDir,
          parentStreamLog: this.parentStreamLog,
          postProcessors: this.postProcessors,
          mainDialogStore: this.mainDialogStore,
          moveTaskToDone: this.moveTaskToDone.bind(this),
          moveTaskToFailed: this.moveTaskToFailed.bind(this),
          toolTimeoutMs: this.toolTimeoutMs,
          permissionChecker: this.permissionChecker,
          askMotionToolFactory: this.askMotionToolFactory,
        });
      }
    } catch (error) {
      const errorMsg = formatErr(error);
      emitStartFailed(this.auditWriter, {
        taskId: task.id,
        error: formatErr(error),
      });
      // 通知 parent，避免永久挂起
      await sendFallbackError(this.fs, this.auditWriter, task, `Task failed to start: ${errorMsg}`).catch((e) => {
        emitStartFailed(this.auditWriter, {
          taskId: task.id,
          context: 'sendFallbackError',
          error: formatErr(e),
        });
      });
      

    } finally {
      // Remove from running and trigger next dispatch
      this.runningTasks.delete(task.id);
      this._dispatch();
    }
  }

  /**
   * Move task file from pending to running directory
   */
  private async movePendingToRunning(taskId: TaskId): Promise<void> {
    await this.fs.move(
      `${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`,
      `${TASKS_QUEUES_RUNNING_DIR}/${taskId}.json`
    );
    emitTaskStarted(this.auditWriter, { taskId });
  }

  /**
   * Move task file from running to done
   */
  private async moveTaskToDone(taskId: TaskId): Promise<void> {
    try {
      await this.fs.move(
        `${TASKS_QUEUES_RUNNING_DIR}/${taskId}.json`,
        `${TASKS_QUEUES_DONE_DIR}/${taskId}.json`
      );
    } catch (err) {
      emitMoveFailed(this.auditWriter, {
        taskId,
        context: 'move_to_done',
        error: formatErr(err),
      });
      // 删除 running 文件防止重启后重复执行，丢失记录好过重复副作用
      await this.fs.delete(`${TASKS_QUEUES_RUNNING_DIR}/${taskId}.json`).catch((e) => {
        emitMoveFailed(this.auditWriter, {
          taskId,
          context: 'move_done_delete',
          error: formatErr(e),
        });
      });
    }
  }

  private async moveTaskToFailed(taskId: TaskId): Promise<void> {
    try {
      await this.fs.move(
        `${TASKS_QUEUES_RUNNING_DIR}/${taskId}.json`,
        `${TASKS_QUEUES_FAILED_DIR}/${taskId}.json`
      );
    } catch (err) {
      emitMoveFailed(this.auditWriter, {
        taskId,
        context: 'move_to_failed',
        error: formatErr(err),
      });
      await this.fs.delete(`${TASKS_QUEUES_RUNNING_DIR}/${taskId}.json`).catch((e) => {
        emitMoveFailed(this.auditWriter, {
          taskId,
          context: 'move_failed_delete',
          error: formatErr(e),
        });
      });
    }
  }

  /**
   * List running task IDs
   */
  listRunning(): string[] {
    return Array.from(this.runningTasks.keys());
  }

  getRunningCount(): number {
    return this.runningTasks.size;
  }

  /**
   * List pending task IDs.
   *
   * 语义：仅返回内存中等调度的任务（pendingQueue）；
   * subagent 文件未被 watcher / startDispatch 拾起前不可见。
   * 欲看完整 pending 状态请直读 TASKS_QUEUES_PENDING_DIR/ 目录。
   */
  listPending(): string[] {
    return this.pendingQueue.map(task => task.id);
  }

  getPendingCount(): number {
    return this.pendingQueue.length;
  }

  getCancellingIds(): string[] {
    return [...this.cancellingIds];
  }

  /**
   * Cancel a running task
   */
  async cancel(taskId: TaskId): Promise<void> {
    // 1. 先检查 running
    const state = this.runningTasks.get(taskId);
    if (state) {
      state.abortController.abort();
      try {
        await state.promise;
      } catch (err) {
        // abort 设计意是同步 cancel 不等 settle，但 reject content forensics 留痕
        // per feedback_silent_x_audit_kit (silent catch swallow → audit 注入)
        try {
          emitCancelPromiseRejected(this.auditWriter, {
            taskId,
            error: formatErr(err),
          });
        } catch (innerErr) {
          // L2 audit writer recursion border: align `[AUDIT CRITICAL]` console.error pattern
          // (foundation/audit/writer.ts:81+99 + foundation/audit/index.ts:14-16 design)
          console.error(`[AUDIT CRITICAL] task cancel audit nested throw: taskId=${taskId} reason=${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
        }
      }
      emitCancelled(this.auditWriter, { taskId, from: 'running' });
      return;
    }

    // 2. 再检查 pending（内存队列 + 文件系统双源）
    this.cancellingIds.add(taskId);
    try {
      const fileExists = await this.fs.exists(`${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`);
      const queueIdx = this.pendingQueue.findIndex(t => t.id === taskId);

      if (queueIdx === -1 && !fileExists) {
        throw new Error(`Task ${taskId} not found in running or pending`);
      }

      let task: SubAgentTask | ToolTask | undefined =
        queueIdx !== -1 ? this.pendingQueue[queueIdx] : undefined;
      if (queueIdx !== -1) this.pendingQueue.splice(queueIdx, 1);

      // 若仅文件存在（未入队或已 shift），尝试从盘读出以决定是否 sendFallbackError
      if (!task && fileExists) {
        const filePath = `${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`;
        let content: string | undefined;
        try {
          content = await this.fs.read(filePath);
          const parsed: unknown = JSON.parse(content);
          if (validateTaskShape(parsed)) {
            task = parsed as SubAgentTask | ToolTask;
          } else {
            await backupCorruptTask(this.fs, this.auditWriter, filePath, content, new Error('shape_mismatch'));
          }
        } catch (e) {
          if (content !== undefined) {
            await backupCorruptTask(this.fs, this.auditWriter, filePath, content, e).catch(() => { /* silent: fs.move path covered by backupCorruptTask */ });
          }
          // read 失败 → 跳过 / 后续 move 仍尝试
          // phase 1013 E.4: parse fail 显式 audit 留痕
          emitParseFailed(this.auditWriter, {
            taskId,
            context: 'cancel_pending_load',
            error: formatErr(e),
          });
        }
      }

      // 文件：pending → failed
      if (fileExists) {
        await this.fs.move(
          `${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`,
          `${TASKS_QUEUES_FAILED_DIR}/${taskId}.json`
        ).catch((e) => {
          const code = (e as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
            // race-loss: dispatch 已 movePendingToRunning / cancel pending move 失败是预期 (phase 1011 D.3)
            emitTaskCancelRaceLostToDispatch(this.auditWriter, { taskId });
          } else {
            emitMoveFailed(this.auditWriter, {
              taskId,
              context: 'cancel_pending_move',
              error: formatErr(e),
            });
          }
        });
      }

      // tool 任务：通知 parent
      if (task?.kind === 'tool') {
        await sendFallbackError(this.fs, this.auditWriter, task, 'Task cancelled before execution').catch((e) => {
          emitMoveFailed(this.auditWriter, {
            taskId,
            context: 'cancel_sendFallbackError',
            error: formatErr(e),
          });
        });
      }

      emitCancelled(this.auditWriter, { taskId, from: 'pending' });
    } finally {
      this.cancellingIds.delete(taskId);
    }
  }

  /**
   * Shutdown - wait for all tasks to complete or timeout
   */


  private buildToolTaskExecContext(task: ToolTask, signal: AbortSignal): import('../../foundation/tools/index.js').ExecContext {
    return {
      clawId: makeClawId(task.parentClawId),
      clawDir: makeClawDir(task.parentClawDir),
      workspaceDir: path.join(task.parentClawDir, CLAWSPACE_DIR),
      syncDir: path.join(task.parentClawDir, TASKS_SYNC_DIR),
      allowedGroups: CALLER_TYPE_TO_GROUPS[task.callerType ?? 'claw'],
      callerLabel: task.callerType ?? 'claw',
      fs: this.fs,
      fsFactory: this.fsFactory,
      profile: 'full',
      stepNumber: 0,
      maxSteps: 1,
      signal,
      isMotionChain: task.parentClawId === MOTION_CLAW_ID,
      isShadow: task.isShadow,
      auditWriter: this.auditWriter,
      getElapsedMs: () => 0,
      incrementStep: () => { /* no-op */ },
      fullyReadPaths: new Set(),
      stopRequested: false,
      requestStop: () => { /* no-op (async tool tasks run a single tool, not a ReAct loop) */ },
    };
  }

  /**
   * Abort all running tasks immediately.
   * Used by Runtime when shutdown timeout is hit (phase 1332 N4).
   */
  abort(): void {
    for (const state of this.runningTasks.values()) {
      state.abortController.abort();
    }
  }

  async shutdown(timeoutMs: number = 30000): Promise<boolean> {
    this._shuttingDown = true;
    // 顺序：先关 watcher（避免 shutdown 期间新事件进队）→ 旧 shutdown 流程
    await this.pendingWatcher?.close();
    this.pendingWatcher = undefined;

    // Signal all running tasks to stop
    this.abort();

    // Wait for all tasks with timeout
    let timedOut = false;
    if (this.runningTasks.size > 0) {
      const promises = Array.from(this.runningTasks.values()).map(s => s.promise);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(promises),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Shutdown timeout')), timeoutMs);
          }),
        ]).catch(() => {
          timedOut = true;
          emitShutdownTimeout(this.auditWriter);
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    // NEW: drain any remaining task promises (file moves in finally blocks) outside the timeout budget.
    // Use SHUTDOWN_DRAIN_GRACE_MS grace cap to avoid indefinite hangs on misbehaving tasks (phase 779 Step B / phase 863 const promote).
    const remainingPromises = Array.from(this.runningTasks.values()).map(s => s.promise);
    if (remainingPromises.length > 0) {
      await Promise.race([
        Promise.allSettled(remainingPromises),
        new Promise(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_GRACE_MS)),
      ]);
    }
    emitShutdownPendingCleanupsDrained(this.auditWriter);

    this.runningTasks.clear();
    this.pendingQueue = [];

    return timedOut;
  }
}
