/**
 * AsyncTaskSystem - SubAgent task lifecycle management
 * 
 * Manages subagent task queue and execution using directory-based persistence.
 * Uses a pending queue + dispatcher pattern for concurrency control.
 */

import { newUuid } from '../../foundation/uuid.js';
import { MOTION_CLAW_ID } from '../claw-topology/index.js';
import { makeStepNumber } from '../agent-executor/step-number.js';
import { CALLER_TYPE_TO_GROUPS } from '../caller-types.js';
import * as path from 'path';

import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';

import { DEFAULT_MAX_CONCURRENT_TASKS, SHUTDOWN_DRAIN_GRACE_MS, SHUTDOWN_DEFAULT_TIMEOUT_MS, DEFAULT_RETRY_BASE_DELAY_MS, PENDING_QUEUE_MAX } from './constants.js';
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
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import type { StreamLog } from '../../foundation/stream/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import type { Tool } from '../../foundation/tools/index.js';
import { sendFallbackError } from './result-delivery.js';
import { recoverTasks } from './task-recovery.js';
import { validateTaskShape, backupCorruptTask } from './task-corrupt-helpers.js';
import { executeSubAgentTask } from './subagent-executor.js';
import { executeToolTask } from './tool-executor.js';
import { createPendingWatcher, type PendingWatcherHandle } from './pending-watcher.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { STREAM_TASK_EVENTS } from './stream-events.js';
import { formatErr } from './_helpers.js';
import { assertTaskShapeOnSave } from './invariants.js';
import { auditQueueCrossSource } from './queue-cross-source-audit.js';
import {
  emitTaskScheduled,
  emitTaskStarted,
  emitPendingIngestFailed,
  emitPendingQueueOverflow,
  emitPendingQueueOverflowNotified,
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
import type { AsyncTaskSystemOptions, SubAgentTask, ToolTask, TaskKind, TaskExecutor } from './types.js';
import { type TaskId, makeTaskId } from './types.js';




interface TaskState {
  abortController: AbortController;
  promise: Promise<void>;
}

export class AsyncTaskSystem {
  // Runtime execution handles only (abort controller + promise). This is NOT a memory view of
  // the running set; the fs running directory remains the authoritative running state.
  private executingTasks: Map<string, TaskState> = new Map();
  private _dispatching = false;
  private readonly maxConcurrent: number;
  private readonly registry: ToolRegistry;
  private readonly llm: LLMOrchestrator;
  private readonly selfInbox?: InboxWriter;
  // phase 7: dedup overflow 通知 / 同 overflow 窗口 (queue 满) 多次 reject 仅 1 通知 / 队列降回 cap 以下后清 0 允许下次再发
  private overflowNotified = false;
  private auditWriter: AuditLog;
  private parentStreamLog?: StreamLog;
  private pendingWatcherHandle?: PendingWatcherHandle;
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
  
  private readonly retryBaseDelayMs: number;
  private readonly executors: Record<TaskKind, TaskExecutor>;

  constructor(
    private readonly clawDir: string,
    private readonly fs: FileSystem,
    private readonly options: AsyncTaskSystemOptions,
  ) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.auditWriter = options.auditWriter;
    this.parentStreamLog = options.parentStreamLog;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.llm = options.llm;
    this.selfInbox = options.selfInbox;
    this.mainDialogStore = options.mainDialogStore;
    this.registry = options.registry;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.permissionChecker = options.permissionChecker;
    this.fsFactory = options.fsFactory;
    this.askMotionToolFactory = options.askMotionToolFactory;

    // Strategy table: dispatches task body by kind. Adding a new kind
    // requires extending union + registering one entry — _startTask itself
    // does not change. (phase 16 Step B / audit finding H2)
    this.executors = {
      tool: async (task, signal) => {
        if (task.kind !== 'tool') return;
        const tool = this.registry.getAll().find(t => t.name === task.toolName);
        if (!tool) {
          await this.fs.delete(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`).catch((err) => {
            this.auditWriter?.write(
              TASK_AUDIT_EVENTS.RUNNING_FILE_DELETE_FAILED,
              `task_id=${task.id}`,
              `reason=${formatErr(err)}`,
            );
          });
          const violationMsg = `Tool "${task.toolName}" not found in registry (装配 bug)`;
          this.auditWriter?.write(
            TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
            `site=async-task-system/system.ts:151`,
            `kind=tool_not_found_registry`,
            `toolName=${task.toolName}`,
            `msg=${violationMsg}`,
          );
          throw new Error(`[INVARIANT VIOLATION] async-task-system: ${violationMsg}`);
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
      },
      subagent: async (task, signal) => {
        if (task.kind === 'tool') return;
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
      },
    };
  }

  async initialize(): Promise<void> {
    // Ensure task directories exist
    await this.fs.ensureDir(TASKS_QUEUES_PENDING_DIR);
    await this.fs.ensureDir(TASKS_QUEUES_RUNNING_DIR);
    await this.fs.ensureDir(TASKS_QUEUES_DONE_DIR);
    await this.fs.ensureDir(TASKS_QUEUES_FAILED_DIR);
    await this.fs.ensureDir(TASKS_QUEUES_RESULTS_DIR);

    // Cold-start recovery: running tasks are moved back to pending by recoverTasks.
    // No in-memory pending queue is kept; pending state is derived from fs on demand.
    await recoverTasks({ fs: this.fs, auditWriter: this.auditWriter });
  }

  /**
   * Start dispatching pending tasks.
   * The LLM service is injected via constructor; dispatch is ready once
   * initialize() has completed.
   */
  startDispatch(): void {
    if (!this.pendingWatcherHandle) {
      this.pendingWatcherHandle = createPendingWatcher({
        fs: this.fs,
        auditWriter: this.auditWriter,
        pendingDir: TASKS_QUEUES_PENDING_DIR,
        ingest: (filePath) => this._ingestPendingFile(filePath),
        createWatcher: this.options.createWatcher,
      });
    }
    void this.pendingWatcherHandle.start();
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
    const taskId = makeTaskId(newUuid());
    const task = {
      ...payload,
      id: taskId,
      createdAt: new Date().toISOString(),
    } as SubAgentTask;

    // Save to pending directory; watcher will pick up and dispatch
    const taskPath = `${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`;

    // phase 239 Step A: schema invariant check（违例 emit audit、不 throw、不阻 save、Path #4）
    assertTaskShapeOnSave(task, this.auditWriter, 'schedule_subagent');

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
   * Dedup gate: check runtime execution handles + transient cancelling set.
   * The actual pending/running authoritative state lives on fs; this gate only
   * prevents duplicate ingestion/dispatch for ids already being processed in
   * memory. Concurrent ingestion of the same file is serialized by the dispatch
   * loop guard and fs.move atomicity.
   */
  private _isDuplicate(taskId: TaskId): boolean {
    return this.executingTasks.has(taskId) || this.cancellingIds.has(taskId);
  }

  /**
   * Async load + parse a task file. Returns null if parsing fails or shape is invalid.
   * Backups corrupt files to prevent repeated ingestion attempts.
   */
  private async _loadTaskFromFile(filePath: string): Promise<SubAgentTask | ToolTask | null> {
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
   * Derive pending task ids from the pending directory, excluding tasks that are
   * currently being cancelled.
   */
  private async _getPendingTaskIds(): Promise<Set<string>> {
    let entries: Awaited<ReturnType<FileSystem['list']>>;
    try {
      entries = await this.fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    } catch (err) {
      // Race: pending dir or an entry disappeared between list and stat (NodeFileSystem.list stats entries).
      if (isFileNotFound(err)) return new Set();
      throw err;
    }
    const ids = new Set<string>();
    for (const e of entries) {
      if (!e.name.endsWith('.json')) continue;
      const id = e.name.slice(0, -5);
      if (this.cancellingIds.has(id)) continue;
      ids.add(id);
    }
    return ids;
  }

  /**
   * Derive pending tasks from fs: list, parse, filter cancellingIds, sort by createdAt.
   */
  private async _getPendingTasks(): Promise<Array<SubAgentTask | ToolTask>> {
    const ids = await this._getPendingTaskIds();
    const tasks: Array<SubAgentTask | ToolTask> = [];
    for (const id of ids) {
      const filePath = `${TASKS_QUEUES_PENDING_DIR}/${id}.json`;
      try {
        const task = await this._loadTaskFromFile(filePath);
        if (task) {
          tasks.push(task);
        } else {
          // schema drift / corrupt file: emit audit, skip (derive is read-only)
          this.auditWriter?.write(
            TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED,
            `task_id=${id}`,
            `context=derive_pending_corrupt`,
            `reason=load_returned_null`,
          );
        }
      } catch (err) {
        if (isFileNotFound(err)) continue; // race: file moved/deleted between list and read
        this.auditWriter?.write(
          TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED,
          `task_id=${id}`,
          `context=derive_pending_corrupt`,
          `error=${formatErr(err)}`,
        );
      }
    }
    tasks.sort((a, b) => {
      const ta = a.createdAt ?? '';
      const tb = b.createdAt ?? '';
      if (ta && tb) return ta.localeCompare(tb);
      return ta ? -1 : tb ? 1 : a.id.localeCompare(b.id);
    });
    return tasks;
  }

  /**
   * Enqueue a validated task (with cap check) and trigger dispatch.
   * The task file is already persisted in pending/; this method only drives the
   * dispatcher and handles overflow by moving the file to failed/.
   */
  private async _enqueueAndDispatch(task: SubAgentTask | ToolTask): Promise<void> {
    const pendingIds = await this._getPendingTaskIds();
    const pendingCount = pendingIds.size;

    // T6: PENDING_QUEUE_MAX cap check
    if (pendingCount >= PENDING_QUEUE_MAX) {
      emitPendingQueueOverflow(this.auditWriter, {
        taskId: task.id,
        queueLength: pendingCount,
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

      // phase 7: Notify self daemon of system-level overload (best-effort) / dedup 同 overflow 窗口 1 通知
      // phase 37 rename: motion daemon → 写 motion 自家、worker daemon → 写 worker 自家
      if (this.selfInbox && !this.overflowNotified) {
        try {
          this.selfInbox.writeSync({
            type: 'task_queue_overflow',
            source: 'async-task-system',
            priority: 'critical',
            body: `Task queue is at capacity (${PENDING_QUEUE_MAX} pending). The system is unable to dispatch tasks fast enough — likely a chronic processing failure.`,
            idPrefix: `${Date.now()}_overflow`,
            extraFields: {
              cap: String(PENDING_QUEUE_MAX),
              queue_length: String(pendingCount),
            },
          });
          emitPendingQueueOverflowNotified(this.auditWriter, {
            taskId: task.id,
            queueLength: pendingCount,
            cap: PENDING_QUEUE_MAX,
          });
          this.overflowNotified = true;   // dedup until queue drains below cap
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

    // phase 7: queue 已降回 cap 以下 / 重置 dedup 允许下次 overflow 再发通知
    if (this.overflowNotified && pendingCount < PENDING_QUEUE_MAX) {
      this.overflowNotified = false;
    }

    this._dispatch();
  }

  /**
   * Ingest a single pending file: read, parse, dedupe, dispatch.
   * Shared by watcher callback and _initialScanPending.
   */
  private async _ingestPendingFile(filePath: string): Promise<void> {
    let taskId: TaskId | undefined;
    try {
      taskId = makeTaskId(path.basename(filePath, '.json'));
      if (!taskId || this._isDuplicate(taskId)) return;

      const task = await this._loadTaskFromFile(filePath);
      if (!task) return;

      // β race fix (phase 556 + phase 612): concurrent ingest 同 taskId 可
      // 在 _loadTaskFromFile await 间隙双通过 sync gate / cancel 也可 race ahead.
      // Re-check runtime handles to prevent:
      // (a) cancel 期间 ghost dispatch (phase 556 β)
      // (b) concurrent ingest 双 dispatch 同 taskId (phase 612 P1.7)
      // (c) 上次 ingest 已 dispatch 但本次 await 慢于其
      if (!taskId || this._isDuplicate(taskId)) return;

      await this._enqueueAndDispatch(task);

      // phase 284: QC-4 only (cancellingIds subset of active) after ingest
      void auditQueueCrossSource(
        { cancellingIds: new Set(this.cancellingIds) },
        this.fs,
        this.auditWriter,
        'ingest_pending_file',
      ).catch(() => { /* audit 路径 self-defensive、不影响主路径 */ });
    } catch (err) {
      emitPendingIngestFailed(this.auditWriter, {
        taskId: taskId ?? '<unknown>',
        path: filePath,
        error: formatErr(err),
      });
    }
  }

  /**
   * Trigger the dispatch loop if not already running.
   * Pending tasks are derived from fs on each iteration.
   */
  private _dispatch(): void {
    if (this._shuttingDown || this._dispatching) return;
    this._dispatching = true;
    void this._runDispatchLoop().finally(() => {
      this._dispatching = false;
    });
  }

  /**
   * Core dispatch loop: derive pending tasks from fs, then start them until
   * concurrency is saturated. Only one loop runs at a time to prevent duplicate
   * starts of the same pending file.
   */
  private async _runDispatchLoop(): Promise<void> {
    while (this.executingTasks.size < this.maxConcurrent && !this._shuttingDown) {
      const pendingTasks = await this._getPendingTasks();
      const task = pendingTasks.find(t => !this.executingTasks.has(t.id));
      if (!task) break;

      const abortController = new AbortController();

      // Start the task (this will handle file move + execution)
      const promise = this._startTask(task, abortController.signal);

      // IMMEDIATELY occupy slot - critical to prevent race conditions
      this.executingTasks.set(task.id, { abortController, promise });
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
      await this.movePendingToRunning(task.id);

      // phase 284: QC-4 only (cancellingIds subset of active) after move
      void auditQueueCrossSource(
        { cancellingIds: new Set(this.cancellingIds) },
        this.fs,
        this.auditWriter,
        'dispatch_after_move',
      ).catch(() => { /* audit 路径 self-defensive、不影响主路径 */ });

      // task_started: ToolTask emitted here (no per-task result dir / no stream reader needed);
      // SubAgentTask emitted in executeSubAgentTask after dir creation.
      if (task.kind === 'tool') {
        this.parentStreamLog?.write({
          ts: Date.now(),
          type: STREAM_TASK_EVENTS.TASK_STARTED,
          taskId: task.id,
          callerType: task.callerType ?? 'subagent',
          silent: false,
        });
      }

      await this.executors[task.kind](task, signal);
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
      this.executingTasks.delete(task.id);
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
   * List running task IDs (active executions).
   */
  listRunning(): string[] {
    return Array.from(this.executingTasks.keys());
  }

  getRunningCount(): number {
    return this.executingTasks.size;
  }

  /**
   * List pending task IDs derived from fs.
   */
  async listPending(): Promise<string[]> {
    const ids = await this._getPendingTaskIds();
    return Array.from(ids);
  }

  async getPendingCount(): Promise<number> {
    const ids = await this._getPendingTaskIds();
    return ids.size;
  }

  getCancellingIds(): string[] {
    return [...this.cancellingIds];
  }

  /**
   * Cancel a running or pending task.
   */
  async cancel(taskId: TaskId): Promise<void> {
    // 1. 先检查 running (active execution handles)
    const state = this.executingTasks.get(taskId);
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
          console.error(`[AUDIT CRITICAL] task cancel audit nested throw: taskId=${taskId} reason=${formatErr(innerErr)}`);
        }
      }
      emitCancelled(this.auditWriter, { taskId, from: 'running' });
      return;
    }

    // 2. 再检查 pending（derive from fs）
    this.cancellingIds.add(taskId);
    try {
      const fileExists = await this.fs.exists(`${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`);

      if (!fileExists) {
        const violationMsg = `Task ${taskId} not found in running or pending (race / caller bug)`;
        this.auditWriter?.write(
          TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
          `site=async-task-system/system.ts:cancel`,
          `kind=task_not_found`,
          `taskId=${taskId}`,
          `msg=${violationMsg}`,
        );
        throw new Error(`[INVARIANT VIOLATION] async-task-system: ${violationMsg}`);
      }

      // 从盘读出以决定是否 sendFallbackError
      let task: SubAgentTask | ToolTask | undefined;
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

      // 文件：pending → failed
      await this.fs.move(
        `${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`,
        `${TASKS_QUEUES_FAILED_DIR}/${taskId}.json`
      ).catch((e) => {
        if (isFileNotFound(e)) {
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
      clawId: task.parentClawId,
      clawDir: task.parentClawDir,
      workspaceDir: path.join(task.parentClawDir, CLAWSPACE_DIR),
      syncDir: path.join(task.parentClawDir, TASKS_SYNC_DIR),
      allowedGroups: CALLER_TYPE_TO_GROUPS[task.callerType ?? 'claw'],
      callerLabel: task.callerType ?? 'claw',
      fs: this.fs,
      fsFactory: this.fsFactory,
      profile: 'full',
      stepNumber: makeStepNumber(0),
      maxSteps: 1,
      signal,
      isMotionChain: task.parentClawId === MOTION_CLAW_ID,
      auditWriter: this.auditWriter,
      getElapsedMs: () => 0,
      incrementStep: () => { /* no-op */ },
      readFileState: new Map(),
      stopRequested: false,
      requestStop: () => { /* no-op (async tool tasks run a single tool, not a ReAct loop) */ },
    };
  }

  /**
   * Abort all running tasks immediately.
   * Used by Runtime when shutdown timeout is hit (phase 1332 N4).
   */
  abort(): void {
    for (const state of this.executingTasks.values()) {
      state.abortController.abort();
    }
  }

  async shutdown(timeoutMs: number = SHUTDOWN_DEFAULT_TIMEOUT_MS): Promise<boolean> {
    // phase 546: 幂等 guard — disassemble 链 / 异常路径可能重入、防 abort 二次 + drain 重跑
    if (this._shuttingDown) return false;
    this._shuttingDown = true;
    // 顺序：先关 watcher（避免 shutdown 期间新事件进队）→ 旧 shutdown 流程
    await this.pendingWatcherHandle?.close();
    this.pendingWatcherHandle = undefined;

    // Signal all running tasks to stop
    this.abort();

    // Wait for all tasks with timeout
    let timedOut = false;
    if (this.executingTasks.size > 0) {
      const promises = Array.from(this.executingTasks.values()).map(s => s.promise);
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
    const remainingPromises = Array.from(this.executingTasks.values()).map(s => s.promise);
    if (remainingPromises.length > 0) {
      await Promise.race([
        Promise.allSettled(remainingPromises),
        new Promise(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_GRACE_MS)),
      ]);
    }
    emitShutdownPendingCleanupsDrained(this.auditWriter);

    this.executingTasks.clear();

    return timedOut;
  }
}
