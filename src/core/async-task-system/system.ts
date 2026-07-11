/**
 * AsyncTaskSystem - SubAgent task lifecycle management
 * 
 * Manages subagent task queue and execution using directory-based persistence.
 * Uses a pending queue + dispatcher pattern for concurrency control.
 */

import { newUuid } from '../../foundation/node-utils/index.js';

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
import { createAsyncExecWrapper, type AsyncExecWrapperParams } from './async-exec-wrapper.js';
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
import type { AsyncTaskSystemOptions, SubAgentTask, ToolTask, TaskKind, TaskExecutor, FullTaskId, ShortTaskId, ShortIdIndex } from './types.js';
import { type TaskId, makeFullTaskId, makeShortTaskId, deriveShortIdFromTaskId, taskShortId } from './types.js';




interface TaskState {
  abortController: AbortController;
  promise: Promise<void>;
}

export class AsyncTaskSystem {
  // Runtime execution handles only (abort controller + promise). This is NOT a memory view of
  // the running set; the fs running directory remains the authoritative running state.
  private executingTasks: Map<FullTaskId, TaskState> = new Map();
  private _wakeupRequested = false;
  private _wakeupResolve: (() => void) | null = null;
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
  private cancellingIds: Set<FullTaskId> = new Set();
  private readonly toolTimeoutMs?: number;
  private permissionChecker?: PermissionChecker;
  private fsFactory: (baseDir: string) => FileSystem;
  private readonly askMotionToolFactory: (llm: LLMOrchestrator, motionDialogStore: DialogStore) => Tool;
  private readonly shortIdIndex: ShortIdIndex;
  private _shuttingDown = false;
  private _dispatchRunning = false;
  private _startPromise: Promise<void> | null = null;

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

  /**
   * Phase 833: inject the parent stream log after construction so migrated exec
   * tasks can emit `task_started` / `task_completed` viewport events.
   */
  setParentStreamLog(streamLog: StreamLog): void {
    this.parentStreamLog = streamLog;
  }

  /**
   * Phase 770: create an async-aware `exec` Tool.
   *
   * The returned Tool shares the same name/schema/profiles as the sync exec Tool,
   * but migrates commands that exceed the soft timeout to background execution.
   */
  createAsyncExecWrapper(params: AsyncExecWrapperParams): Tool {
    return createAsyncExecWrapper(params, {
      fs: this.fs,
      auditWriter: this.auditWriter,
      retryBaseDelayMs: this.retryBaseDelayMs,
      moveTaskToDone: (id: TaskId) => this.moveTaskToDone(id),
      moveTaskToFailed: (id: TaskId) => this.moveTaskToFailed(id),
      parentStreamLog: this.parentStreamLog,
      shortIdIndex: this.shortIdIndex,
    });
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
    this.shortIdIndex = options.shortIdIndex;

    // Strategy table: dispatches task body by kind. Adding a new kind
    // requires extending union + registering one entry — _startTask itself
    // does not change. (phase 16 Step B / audit finding H2)
    this.executors = {
      tool: async (task, signal) => {
        if (task.kind !== 'tool') return;
        const tool = this.registry.getAll().find(t => t.name === task.toolName);
        if (!tool) {
          const runningPath = `${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`;
          try {
            await this._setTerminalState(runningPath, 'failed');
            await this.fs.move(runningPath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)
              .catch((moveErr) => {
                emitMoveFailed(this.auditWriter, {
                  fullTaskId: task.id as FullTaskId,
                  shortTaskId: taskShortId(task),
                  context: 'tool_not_found_move_to_failed',
                  error: formatErr(moveErr),
                });
              });
          } catch (e) {
            // _setTerminalState failed — audit and keep running for recovery
            emitMoveFailed(this.auditWriter, {
              fullTaskId: task.id as FullTaskId,
              shortTaskId: taskShortId(task),
              context: 'tool_not_found_set_terminal_state_failed',
              error: formatErr(e),
            });
          }
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
          moveTaskToDone: (id: TaskId) => this.moveTaskToDone(id),
          moveTaskToFailed: (id: TaskId) => this.moveTaskToFailed(id),
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
          moveTaskToDone: (id: TaskId) => this.moveTaskToDone(id),
          moveTaskToFailed: (id: TaskId) => this.moveTaskToFailed(id),
          toolTimeoutMs: this.toolTimeoutMs,
          permissionChecker: this.permissionChecker,
          askMotionToolFactory: this.askMotionToolFactory,
        });
      },
    };
  }

  private get shortIdIndexAuditWriter() {
    return {
      write: (event: string, payload: Record<string, unknown>) => {
        const cols = Object.entries(payload).map(([key, value]) => {
          const str = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : JSON.stringify(value);
          return `${key}=${str}`;
        });
        this.auditWriter?.write(event, ...cols);
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

    // Phase 849/854: load shortId ↔ fullId index from disk, rebuild if needed
    this.shortIdIndex.load(this.shortIdIndexAuditWriter);
    if (this.shortIdIndex.needsRebuild) {
      this.shortIdIndex.rebuildFromDisk(this.fs, this.shortIdIndexAuditWriter);
      this.shortIdIndex.save();
    }

    // Phase 868: migrate legacy files BEFORE recovery/dispatch so strict schema
    // validation can assume every task file has explicit `id` + `shortId`.
    await this._migrateLegacyTaskFiles();

    // Cold-start recovery: running tasks are moved back to pending by recoverTasks.
    // No in-memory pending queue is kept; pending state is derived from fs on demand.
    await recoverTasks({ fs: this.fs, auditWriter: this.auditWriter });
  }

  /**
   * One-time disk migration: scan all queue directories for legacy-format
   * task files (8-char filename or missing shortId field) and rewrite them
   * to the Phase 867+ format (UUID filename + id/shortId fields).
   *
   * Must run BEFORE recoverTasks() and _getPendingTasks() so that strict
   * schema validation passes.
   */
  private async _migrateLegacyTaskFiles(): Promise<void> {
    for (const dir of [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR,
                       TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR]) {
      if (!await this.fs.exists(dir)) continue;
      const entries = await this.fs.list(dir, { includeDirs: false });
      for (const e of entries) {
        if (!e.name.endsWith('.json')) continue;
        const oldPath = `${dir}/${e.name}`;
        try {
          const raw = await this.fs.read(oldPath);
          const task = JSON.parse(raw) as Record<string, unknown>;

          // Determine fullId and shortId
          let fullId: FullTaskId;
          let shortId: ShortTaskId;

          const storedId = task.id as string | undefined;
          const storedShortId = task.shortId as string | undefined;
          const nameId = e.name.replace(/\.json$/, '');

          if (storedShortId && storedId && storedId.length === 36) {
            // Already Phase 867+ format — just register index, skip rewrite
            fullId = makeFullTaskId(storedId);
            shortId = makeShortTaskId(storedShortId);
            try {
              this.shortIdIndex.add(shortId, fullId, this.shortIdIndexAuditWriter, 'migrateLegacyTaskFiles');
            } catch {
              // add() already emitted SHORT_ID_COLLISION with context — don't duplicate
              const isActive = dir === TASKS_QUEUES_PENDING_DIR || dir === TASKS_QUEUES_RUNNING_DIR;
              if (isActive) {
                throw new Error(`ShortId collision in ${dir}: ${shortId}`);
              }
              continue;
            }
            if (nameId.length !== 36) {
              // Rename to UUID filename
              const newPath = `${dir}/${fullId}.json`;
              await this.fs.move(oldPath, newPath);
            }
            continue;
          }

          if (storedId && storedId.length === 36) {
            // Pre-867 UUID task without shortId — derive and add
            fullId = makeFullTaskId(storedId);
            shortId = this.shortIdIndex.deriveShortId(fullId);
          } else if (storedId && storedId.length === 8) {
            // Legacy 8-char — preserve as shortId, generate fullId
            shortId = makeShortTaskId(storedId);
            const resolvedFullId = this.shortIdIndex.resolve(shortId);
            if (resolvedFullId) {
              fullId = resolvedFullId;
            } else {
              fullId = makeFullTaskId(newUuid());
              this.shortIdIndex.add(shortId, fullId, this.shortIdIndexAuditWriter, 'migrateLegacyTaskFiles');
            }
          } else {
            this.shortIdIndexAuditWriter.write(TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED, {
              path: oldPath,
              storedId: String(storedId),
              error: `malformed task file: id is missing or has illegal length (${storedId ? storedId.length : 'undefined'})`,
              context: 'migrate_malformed',
            });
            const isActive = dir === TASKS_QUEUES_PENDING_DIR || dir === TASKS_QUEUES_RUNNING_DIR;
            if (isActive) {
              const err = new Error(`Malformed task file in ${dir}: id is missing or has illegal length (${storedId ? storedId.length : 'undefined'})`);
              (err as { isMalformed?: boolean }).isMalformed = true;
              throw err;
            }
            // terminal (done/failed) — audit + skip
            continue;
          }

          // Rewrite JSON with both fields
          task.id = fullId;
          task.shortId = shortId;
          await this.fs.writeAtomic(oldPath, JSON.stringify(task));

          // Rename to UUID filename
          const newPath = `${dir}/${fullId}.json`;
          if (oldPath !== newPath) {
            await this.fs.move(oldPath, newPath);
          }
        } catch (e) {
          if ((e as { isMalformed?: boolean }).isMalformed) {
            throw e; // already audited above
          }
          const isActive = dir === TASKS_QUEUES_PENDING_DIR || dir === TASKS_QUEUES_RUNNING_DIR;
          const context = isActive ? 'active' : 'terminal';
          this.shortIdIndexAuditWriter.write(TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED, {
            path: oldPath,
            error: String(e),
            context: `migrate_${context}`,
          });
          if (isActive) throw e; // can't proceed with corrupted active task
          // terminal → skip
        }
      }
    }
    this.shortIdIndex.save();
  }

  /**
   * Start dispatching pending tasks.
   * The LLM service is injected via constructor; dispatch is ready once
   * initialize() has completed.
   */
  async startDispatch(): Promise<void> {
    if (this._dispatchRunning) return;
    if (this._startPromise) return this._startPromise;

    this._startPromise = (async () => {
      try {
        if (!this.pendingWatcherHandle) {
          this.pendingWatcherHandle = createPendingWatcher({
            fs: this.fs,
            auditWriter: this.auditWriter,
            pendingDir: TASKS_QUEUES_PENDING_DIR,
            ingest: (filePath) => this._ingestPendingFile(filePath),
            createWatcher: this.options.createWatcher,
          });
        }
        await this.pendingWatcherHandle.start();
        this._dispatchRunning = true;
        void this._runDispatchLoop();
        // 首次触发：扫 pending 目录中已有任务
        this._signalWork();
      } catch (e) {
        // Watcher start failed — clean up so the next call can retry
        if (this.pendingWatcherHandle) {
          await this.pendingWatcherHandle.close().catch(() => {});
          this.pendingWatcherHandle = undefined;
        }
        throw e;
      } finally {
        this._startPromise = null;
      }
    })();
    return this._startPromise;
  }

  /**
   * Schedule a new subagent task
   * Returns taskId immediately, task enters pending queue and will be dispatched
   */
  async scheduleSubAgent(taskData: Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>): Promise<string> {
    return this.schedule('subagent', taskData);
  }

  /**
   * Semantic scheduling API (phase 1332 N2).
   * Replaces cross-L4 writePendingSubagentTaskFile leak.
   */
  async schedule(
    taskKind: 'subagent',
    payload: Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>,
  ): Promise<string> {
    // Phase 849: dual-key task IDs. fullId for persistence, shortId for agents/CLI.
    let fullId: FullTaskId;
    let shortId: ShortTaskId;
    do {
      fullId = makeFullTaskId(newUuid());
      shortId = this.shortIdIndex.deriveShortId(fullId);
    } while (this.shortIdIndex.has(shortId));

    const task = {
      ...payload,
      id: fullId,
      shortId: shortId,
      createdAt: new Date().toISOString(),
    } as SubAgentTask;

    // Save to pending directory; watcher will pick up and dispatch
    const taskPath = `${TASKS_QUEUES_PENDING_DIR}/${fullId}.json`;

    // phase 239 Step A: schema invariant check（违例 emit audit、不 throw、不阻 save、Path #4）
    assertTaskShapeOnSave(task, this.auditWriter, 'schedule_subagent');

    await this.fs.writeAtomic(taskPath, JSON.stringify(task, null, 2));

    // Only register index after successful file write to avoid dangling entries.
    // Phase 883: add() failure (collision) must propagate — the shortId is unusable.
    // Phase 885: if add() fails, move the orphaned pending file to failed so it
    // won't be silently executed by the watcher.
    try {
      this.shortIdIndex.add(shortId, fullId);
    } catch (e) {
      this.shortIdIndexAuditWriter.write(TASK_AUDIT_EVENTS.INVARIANT_VIOLATION, {
        site: 'schedule_add_collision',
        shortId,
        fullId,
        error: formatErr(e),
      });
      await this.fs.move(taskPath, `${TASKS_QUEUES_FAILED_DIR}/${fullId}.json`)
        .catch((moveErr) => {
          emitMoveFailed(this.auditWriter, {
            fullTaskId: fullId,
            shortTaskId: shortId,
            context: 'schedule_add_collision_move_to_failed',
            error: formatErr(moveErr),
          });
        });
      throw e;
    }

    let indexPersisted = true;
    try {
      this.shortIdIndex.save();
    } catch (e) {
      indexPersisted = false;
      // File is already written and may be picked up by watcher.
      // Don't delete it — rebuildFromDisk() will recover the index on next startup.
      // The caller must NOT retry; the task will execute from the pending file.
      this.shortIdIndexAuditWriter.write(TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED, {
        path: taskPath,
        error: `schedule index save failed: ${String(e)}`,
        context: 'schedule_index_save',
      });
    }

    emitTaskScheduled(this.auditWriter, {
      fullTaskId: fullId,
      shortTaskId: shortId,
      kind: taskKind,
      parent: task.parentClawId,
      maxSteps: task.maxSteps,
      indexPersisted,
    });

    // No push, no dispatch; watcher ingests asynchronously
    return shortId;
  }



  /**
   * Resolve any TaskId (short or full) to the canonical FullTaskId.
   * Short IDs are looked up in the ShortIdIndex; FullTaskIds pass through.
   */
  private _resolveFullTaskId(taskId: TaskId): FullTaskId {
    if (taskId.length === 36) return taskId as FullTaskId;
    const resolved = this.shortIdIndex.resolve(taskId);
    if (resolved) return resolved;
    // Fallback: treat non-8-char / non-indexed IDs as legacy full IDs (test fixtures).
    return taskId as FullTaskId;
  }

  /**
   * Public resolver for tests / tooling to map a shortId to the persisted FullTaskId.
   */
  resolveFullTaskId(taskId: string): string {
    return this._resolveFullTaskId(taskId as TaskId);
  }

  /**
   * Dedup gate: check runtime execution handles + transient cancelling set.
   * The actual pending/running authoritative state lives on fs; this gate only
   * prevents duplicate ingestion/dispatch for ids already being processed in
   * memory. Concurrent ingestion of the same file is serialized by the dispatch
   * loop guard and fs.move atomicity.
   */
  private _isDuplicate(taskId: TaskId): boolean {
    const fullId = this._resolveFullTaskId(taskId);
    if (!fullId) return false;
    return this.executingTasks.has(fullId) || this.cancellingIds.has(fullId);
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
   * currently being cancelled. Returns canonical FullTaskIds.
   */
  private async _getPendingTaskIds(): Promise<Set<FullTaskId>> {
    let entries: Awaited<ReturnType<FileSystem['list']>>;
    try {
      entries = await this.fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    } catch (err) {
      // Race: pending dir or an entry disappeared between list and stat (NodeFileSystem.list stats entries).
      if (isFileNotFound(err)) return new Set();
      throw err;
    }
    const ids = new Set<FullTaskId>();
    for (const e of entries) {
      if (!e.name.endsWith('.json')) continue;
      const nameId = e.name.slice(0, -5);
      let fullId: FullTaskId | undefined;
      if (nameId.length === 36) {
        fullId = makeFullTaskId(nameId);
      } else {
        fullId = this.shortIdIndex.resolve(nameId);
        if (!fullId) {
          // Fallback: legacy / test fixtures with arbitrary-length IDs.
          fullId = makeFullTaskId(nameId);
        }
      }
      if (this.cancellingIds.has(fullId)) continue;
      ids.add(fullId);
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
            `fullTaskId=${id}`,
            `shortTaskId=${deriveShortIdFromTaskId(id)}`,
            `context=derive_pending_corrupt`,
            `reason=load_returned_null`,
          );
        }
      } catch (err) {
        if (isFileNotFound(err)) continue; // race: file moved/deleted between list and read
        this.auditWriter?.write(
          TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED,
          `fullTaskId=${id}`,
          `shortTaskId=${deriveShortIdFromTaskId(id)}`,
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
    const fullId = task.id as FullTaskId;
    const shortId = taskShortId(task);
    const pendingIds = await this._getPendingTaskIds();
    const pendingCount = pendingIds.size;

    // T6: PENDING_QUEUE_MAX cap check
    // Phase 886: off-by-one fix — accept exactly MAX pending tasks, reject MAX+1.
    if (pendingCount > PENDING_QUEUE_MAX) {
      emitPendingQueueOverflow(this.auditWriter, {
        fullTaskId: fullId,
        shortTaskId: shortId,
        queueLength: pendingCount,
        cap: PENDING_QUEUE_MAX,
      });

      // Phase 886: notify parent BEFORE moving so the parent is not left waiting forever.
      await sendFallbackError(this.fs, this.auditWriter, task,
        `Task rejected: pending queue overflow (${pendingCount} > ${PENDING_QUEUE_MAX}).`)
        .catch((e) => {
          emitMoveFailed(this.auditWriter, {
            fullTaskId: fullId,
            shortTaskId: shortId,
            context: 'cap_overflow_notify_failed',
            error: formatErr(e),
          });
        });

      const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${fullId}.json`;
      const failedPath = `${TASKS_QUEUES_FAILED_DIR}/${fullId}.json`;

      // Phase 886: mark terminal state so recovery will not re-execute the task if the move fails.
      try {
        await this._setTerminalState(pendingPath, 'failed');
      } catch {
        // terminalState write failed — still attempt the move
      }

      // Move file to failed/ to prevent restart watcher race re-ingest
      try {
        await this.fs.move(pendingPath, failedPath);
      } catch (moveErr) {
        emitMoveFailed(this.auditWriter, {
          fullTaskId: fullId,
          shortTaskId: shortId,
          context: 'cap_overflow_move',
          error: formatErr(moveErr),
        });
        // Phase 886: move failed — file is still in pending. Re-signal the dispatcher
        // so the next cycle can retry or handle the residual task.
        this._signalWork();
        throw moveErr;
      }

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
            fullTaskId: fullId,
            shortTaskId: shortId,
            queueLength: pendingCount,
            cap: PENDING_QUEUE_MAX,
          });
          this.overflowNotified = true;   // dedup until queue drains below cap
        } catch (notifyErr) {
          emitMoveFailed(this.auditWriter, {
            fullTaskId: fullId,
            shortTaskId: shortId,
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

    this._signalWork();
  }

  /**
   * Ingest a single pending file: read, parse, dedupe, dispatch.
   * Shared by watcher callback and _initialScanPending.
   */
  private async _ingestPendingFile(filePath: string): Promise<void> {
    let taskId: FullTaskId | undefined;
    try {
      const task = await this._loadTaskFromFile(filePath);
      if (!task) return;
      taskId = task.id as FullTaskId;
      if (this._isDuplicate(taskId)) return;

      // β race fix (phase 556 + phase 612): concurrent ingest 同 taskId 可
      // 在 _loadTaskFromFile await 间隙双通过 sync gate / cancel 也可 race ahead.
      // Re-check runtime handles to prevent:
      // (a) cancel 期间 ghost dispatch (phase 556 β)
      // (b) concurrent ingest 双 dispatch 同 taskId (phase 612 P1.7)
      // (c) 上次 ingest 已 dispatch 但本次 await 慢于其
      if (this._isDuplicate(taskId)) return;

      await this._enqueueAndDispatch(task);

      // phase 284: QC-4 only (cancellingIds subset of active) after ingest
      void auditQueueCrossSource(
        { cancellingIds: new Set(Array.from(this.cancellingIds).map(id => this.shortIdIndex.canonicalShortId(id))) },
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

  private _signalWork(): void {
    if (this._wakeupResolve) {
      this._wakeupResolve();
      this._wakeupResolve = null;
    } else {
      this._wakeupRequested = true;
    }
  }

  /**
   * Core dispatch loop: derive pending tasks from fs, then start them until
   * concurrency is saturated. Runs persistently and atomically sleeps when no
   * work is available, avoiding the missed-wakeup race of the previous boolean
   * guard.
   */
  private async _runDispatchLoop(): Promise<void> {
    while (this._dispatchRunning && !this._shuttingDown) {
      try {
        while (this.executingTasks.size < this.maxConcurrent && !this._shuttingDown) {
          const pendingTasks = await this._getPendingTasks();
          const task = pendingTasks.find(t => !this.executingTasks.has(t.id as FullTaskId));
          if (!task) break;
          const abortController = new AbortController();
          const promise = this._startTask(task, abortController.signal);
          this.executingTasks.set(task.id as FullTaskId, { abortController, promise });
        }
        if (this._shuttingDown) return;
        // 原子化睡眠：注册 waiter + 检查 pending flag 在 Promise constructor 内同步完成
        await new Promise<void>(r => {
          this._wakeupResolve = r;
          if (this._wakeupRequested) {
            this._wakeupRequested = false;
            r();
          }
        });
        this._wakeupResolve = null;
      } catch (err) {
        if (this._shuttingDown) return;
        this.auditWriter?.write(
          TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
          `site=async-task-system/system.ts:_runDispatchLoop`,
          `kind=dispatch_loop_error`,
          `error=${formatErr(err)}`,
        );
        await new Promise(r => setTimeout(r, 1000));
      }
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
      await this.movePendingToRunning(task.id as FullTaskId);

      // phase 284: QC-4 only (cancellingIds subset of active) after move
      void auditQueueCrossSource(
        { cancellingIds: new Set(Array.from(this.cancellingIds).map(id => this.shortIdIndex.canonicalShortId(id))) },
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
          taskId: taskShortId(task),
          fullTaskId: task.id,
          taskKind: 'spawn_subagent',
          silent: false,
        });
      }

      await this.executors[task.kind](task, signal);
    } catch (error) {
      const errorMsg = formatErr(error);
      const fullId = task.id as FullTaskId;
      const shortId = taskShortId(task);
      emitStartFailed(this.auditWriter, {
        fullTaskId: fullId,
        shortTaskId: shortId,
        error: formatErr(error),
      });
      // 通知 parent，避免永久挂起
      await sendFallbackError(this.fs, this.auditWriter, task, `Task failed to start: ${errorMsg}`).catch((e) => {
        emitStartFailed(this.auditWriter, {
          fullTaskId: fullId,
          shortTaskId: shortId,
          context: 'sendFallbackError',
          error: formatErr(e),
        });
      });
      

    } finally {
      // Remove from running and signal that a slot is free
      this.executingTasks.delete(task.id as FullTaskId);
      this._signalWork();
    }
  }

  /**
   * Best-effort migrate a task JSON after its file has been renamed to the UUID filename.
   * Phase 867: persists both `id` (fullId) and `shortId`.
   */
  private async _migrateTaskJsonId(filePath: string, fullId: FullTaskId): Promise<void> {
    try {
      const raw = await this.fs.read(filePath);
      const task = JSON.parse(raw) as Record<string, unknown>;
      const legacyShortId = task.shortId as string | undefined;
      let changed = false;
      if (task.id && (task.id as string).length === 8) {
        // Legacy: id is the 8-char shortId → preserve as shortId, set fullId
        task.shortId = task.id;
        task.id = fullId;
        changed = true;
      } else if (!legacyShortId) {
        // Pre-867 UUID task without explicit shortId → derive from fullId
        task.shortId = this.shortIdIndex.deriveShortId(fullId);
        changed = true;
      }
      if (changed) {
        await this.fs.writeAtomic(filePath, JSON.stringify(task));
      }
    } catch {
      // silent: best-effort migration — rebuildFromDisk handles inconsistency
    }
  }

  /**
   * Find a legacy task file by scanning the directory and matching content to the fullId.
   * Returns undefined if no matching file is found.
   */
  private async _findLegacyTaskFile(dir: string, fullId: FullTaskId): Promise<string | undefined> {
    let entries: Awaited<ReturnType<FileSystem['list']>>;
    try {
      entries = await this.fs.list(dir, { includeDirs: false });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const filePath = `${dir}/${entry.name}`;
      try {
        const raw = await this.fs.read(filePath);
        const task = JSON.parse(raw) as Record<string, unknown>;
        const storedId = task.id as string | undefined;
        const storedShortId = task.shortId as string | undefined;
        if (storedId === fullId) {
          return filePath;
        }
        if (storedShortId && this.shortIdIndex.resolve(storedShortId) === fullId) {
          return filePath;
        }
        if (storedId && storedId.length === 8 && this.shortIdIndex.resolve(storedId) === fullId) {
          return filePath;
        }
      } catch {
        // silent: skip unreadable/corrupt files — caller handles not-found
      }
    }
    return undefined;
  }

  /**
   * Move task file from pending to running directory
   */
  private async movePendingToRunning(taskId: TaskId): Promise<void> {
    const fullId = this._resolveFullTaskId(taskId);
    if (!fullId) {
      throw new Error(`[INVARIANT VIOLATION] movePendingToRunning: cannot resolve ${taskId}`);
    }
    const auditShortId = this.shortIdIndex.reverseResolve(fullId) ?? this.shortIdIndex.deriveShortId(fullId);
    const fromFull = `${TASKS_QUEUES_PENDING_DIR}/${fullId}.json`;
    const to = `${TASKS_QUEUES_RUNNING_DIR}/${fullId}.json`;

    let fromPath: string;
    if (await this.fs.exists(fromFull)) {
      fromPath = fromFull;
    } else {
      const legacyPath = await this._findLegacyTaskFile(TASKS_QUEUES_PENDING_DIR, fullId);
      if (!legacyPath) {
        throw new Error(`Cannot find task file for ${fullId} in pending directory`);
      }
      fromPath = legacyPath;
    }

    await this.fs.move(fromPath, to);
    if (fromPath !== fromFull) {
      await this._migrateTaskJsonId(to, fullId);
    }
    emitTaskStarted(this.auditWriter, { fullTaskId: fullId, shortTaskId: auditShortId });
  }

  /**
   * Move task file from running to done
   */
  private async moveTaskToDone(taskId: TaskId): Promise<void> {
    const fullId = this._resolveFullTaskId(taskId);
    if (!fullId) {
      throw new Error(`[INVARIANT VIOLATION] moveTaskToDone: cannot resolve ${taskId}`);
    }
    const auditShortId = this.shortIdIndex.reverseResolve(fullId) ?? this.shortIdIndex.deriveShortId(fullId);

    const fromFull = `${TASKS_QUEUES_RUNNING_DIR}/${fullId}.json`;
    const to = `${TASKS_QUEUES_DONE_DIR}/${fullId}.json`;
    let fromPath: string;
    if (await this.fs.exists(fromFull)) {
      fromPath = fromFull;
    } else {
      const legacyPath = await this._findLegacyTaskFile(TASKS_QUEUES_RUNNING_DIR, fullId);
      if (!legacyPath) {
        throw new Error(`Cannot find task file for ${fullId} in running directory`);
      }
      fromPath = legacyPath;
    }

    // Phase 874: persist terminal state OUTSIDE the move catch.
    // If this fails, the error propagates — we cannot safely proceed.
    await this._setTerminalState(fromPath, 'done');

    try {
      await this.fs.move(fromPath, to);
      if (fromPath !== fromFull) {
        await this._migrateTaskJsonId(to, fullId);
      }
      this.auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_MOVED,
        `fullTaskId=${fullId}`,
        `shortTaskId=${auditShortId}`,
        `from=running`,
        `to=done`,
      );
    } catch (err) {
      emitMoveFailed(this.auditWriter, {
        fullTaskId: fullId,
        shortTaskId: auditShortId,
        context: 'move_to_done',
        error: formatErr(err),
      });
      // Keep the running file — terminalState + sent marker ensure correct recovery routing.
      // On next startup, recoverTasks will see the running file + sent marker
      // and complete the move to done. Deleting the running file would block recovery.
    }
  }

  private async moveTaskToFailed(taskId: TaskId): Promise<void> {
    const fullId = this._resolveFullTaskId(taskId);
    if (!fullId) {
      throw new Error(`[INVARIANT VIOLATION] moveTaskToFailed: cannot resolve ${taskId}`);
    }
    const auditShortId = this.shortIdIndex.reverseResolve(fullId) ?? this.shortIdIndex.deriveShortId(fullId);

    const fromFull = `${TASKS_QUEUES_RUNNING_DIR}/${fullId}.json`;
    const to = `${TASKS_QUEUES_FAILED_DIR}/${fullId}.json`;
    let fromPath: string;
    if (await this.fs.exists(fromFull)) {
      fromPath = fromFull;
    } else {
      const legacyPath = await this._findLegacyTaskFile(TASKS_QUEUES_RUNNING_DIR, fullId);
      if (!legacyPath) {
        throw new Error(`Cannot find task file for ${fullId} in running directory`);
      }
      fromPath = legacyPath;
    }

    // Phase 874: persist terminal state OUTSIDE the move catch.
    // If this fails, the error propagates — we cannot safely proceed.
    await this._setTerminalState(fromPath, 'failed');

    try {
      await this.fs.move(fromPath, to);
      if (fromPath !== fromFull) {
        await this._migrateTaskJsonId(to, fullId);
      }
      this.auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_MOVED,
        `fullTaskId=${fullId}`,
        `shortTaskId=${auditShortId}`,
        `from=running`,
        `to=failed`,
      );
    } catch (err) {
      emitMoveFailed(this.auditWriter, {
        fullTaskId: fullId,
        shortTaskId: auditShortId,
        context: 'move_to_failed',
        error: formatErr(err),
      });
      // Keep the running file — terminalState ensures recovery routes to failed on next startup.
    }
  }

  /**
   * Write terminalState into the task JSON before attempting the move.
   * If the move fails, recovery reads this field to correctly route the task.
   */
  private async _setTerminalState(filePath: string, state: 'done' | 'failed'): Promise<void> {
    try {
      const raw = await this.fs.read(filePath);
      const task = JSON.parse(raw) as Record<string, unknown>;
      task.terminalState = state;
      await this.fs.writeAtomic(filePath, JSON.stringify(task));
    } catch (e) {
      this.auditWriter.write(
        TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED,
        `path=${filePath}`,
        `error=cannot persist terminalState=${state}: ${String(e)}`,
        `context=set_terminal_state`,
      );
      throw e; // can't proceed — recovery would route incorrectly without this field
    }
  }

  /**
   * List running task IDs (active executions).
   */
  listRunning(): ShortTaskId[] {
    return Array.from(this.executingTasks.keys()).map(id => this.shortIdIndex.canonicalShortId(id));
  }

  getRunningCount(): number {
    return this.executingTasks.size;
  }

  /**
   * List pending task IDs derived from fs.
   */
  async listPending(): Promise<ShortTaskId[]> {
    const ids = await this._getPendingTaskIds();
    return Array.from(ids).map(id => this.shortIdIndex.canonicalShortId(id));
  }

  async getPendingCount(): Promise<number> {
    const ids = await this._getPendingTaskIds();
    return ids.size;
  }

  getCancellingIds(): ShortTaskId[] {
    return [...this.cancellingIds].map(id => this.shortIdIndex.canonicalShortId(id));
  }

  /**
   * Cancel a running or pending task.
   */
  async cancel(taskId: TaskId): Promise<void> {
    const fullId = this._resolveFullTaskId(taskId);
    if (!fullId) {
      const violationMsg = `Task ${taskId} not found in ShortIdIndex (race / caller bug)`;
      this.auditWriter?.write(
        TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
        `site=async-task-system/system.ts:cancel`,
        `kind=task_not_found`,
        `taskId=${taskId}`,
        `msg=${violationMsg}`,
      );
      throw new Error(`[INVARIANT VIOLATION] async-task-system: ${violationMsg}`);
    }
    const shortId = this.shortIdIndex.canonicalShortId(fullId);

    // 1. 先检查 running (active execution handles)
    const state = this.executingTasks.get(fullId);
    if (state) {
      state.abortController.abort();
      try {
        await state.promise;
      } catch (err) {
        // abort 设计意是同步 cancel 不等 settle，但 reject content forensics 留痕
        // per feedback_silent_x_audit_kit (silent catch swallow → audit 注入)
        try {
          emitCancelPromiseRejected(this.auditWriter, {
            fullTaskId: fullId,
            shortTaskId: shortId,
            error: formatErr(err),
          });
        } catch (innerErr) {
          // L2 audit writer recursion border: align `[AUDIT CRITICAL]` console.error pattern
          // (foundation/audit/writer.ts:81+99 + foundation/audit/index.ts:14-16 design)
          console.error(`[AUDIT CRITICAL] task cancel audit nested throw: fullTaskId=${fullId} shortTaskId=${shortId} reason=${formatErr(innerErr)}`);
        }
      }
      emitCancelled(this.auditWriter, { fullTaskId: fullId, shortTaskId: shortId, from: 'running' });
      return;
    }

    // 2. 再检查 pending（derive from fs）
    this.cancellingIds.add(fullId);
    try {
      const fullPendingPath = `${TASKS_QUEUES_PENDING_DIR}/${fullId}.json`;
      const legacyPendingPath = `${TASKS_QUEUES_PENDING_DIR}/${shortId}.json`;
      const pendingPath = await this.fs.exists(fullPendingPath).then((exists) => exists ? fullPendingPath : legacyPendingPath);

      // Phase 886: if the task file was already quarantined as corrupt (atomic move to
      // tasks/queues/pending/<id>.json.corrupt-<ts>), don't try to move it to failed/
      // and don't report TASK_CANCEL_RACE_LOST_TO_DISPATCH on the resulting ENOENT.
      // Check both full-id and short-id basenames because the backup preserves the
      // exact filename of the original file that was quarantined.
      const possibleBasenames = [path.basename(fullPendingPath), path.basename(legacyPendingPath)];
      const backupExists = await this.fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false })
        .then((entries) => entries.some((e) => possibleBasenames.some((b) => e.name.startsWith(`${b}.corrupt-`))))
        .catch(() => false);
      if (backupExists) {
        emitCancelled(this.auditWriter, { fullTaskId: fullId, shortTaskId: shortId, from: 'pending_corrupt' });
        return;
      }

      const fileExists = await this.fs.exists(pendingPath);

      if (!fileExists) {
        const violationMsg = `Task ${shortId} not found in running or pending (race / caller bug)`;
        this.auditWriter?.write(
          TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
          `site=async-task-system/system.ts:cancel`,
          `kind=task_not_found`,
          `fullTaskId=${fullId}`,
          `shortTaskId=${shortId}`,
          `msg=${violationMsg}`,
        );
        throw new Error(`[INVARIANT VIOLATION] async-task-system: ${violationMsg}`);
      }

      // 从盘读出以决定是否 sendFallbackError
      let task: SubAgentTask | ToolTask | undefined;
      const filePath = pendingPath;
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
          fullTaskId: fullId,
          shortTaskId: shortId,
          context: 'cancel_pending_load',
          error: formatErr(e),
        });
      }

      // 文件：pending → failed
      let moveFailed = false;
      let raceLost = false;
      await this.fs.move(
        pendingPath,
        `${TASKS_QUEUES_FAILED_DIR}/${fullId}.json`
      ).catch((e) => {
        if (isFileNotFound(e)) {
          // race-loss: dispatch 已 movePendingToRunning / cancel pending move 失败是预期 (phase 1011 D.3)
          raceLost = true;
          emitTaskCancelRaceLostToDispatch(this.auditWriter, { fullTaskId: fullId, shortTaskId: shortId });
        } else {
          moveFailed = true;
          emitMoveFailed(this.auditWriter, {
            fullTaskId: fullId,
            shortTaskId: shortId,
            context: 'cancel_pending_move',
            error: formatErr(e),
          });
        }
      });

      if (moveFailed) {
        // File is still in pending; task will execute. Propagate failure so caller knows.
        throw new Error(`Cancel failed: cannot move task ${shortId} to failed`);
      }

      if (raceLost) {
        // Dispatch already moved the task to running. Try to abort the running task.
        const state = this.executingTasks.get(fullId);
        if (state) {
          state.abortController.abort();
        }
        // Propagate failure so caller knows the cancel race was lost.
        throw new Error(`Cancel race lost: task ${shortId} already dispatched to running`);
      }

      // tool 任务：通知 parent
      if (task?.kind === 'tool') {
        await sendFallbackError(this.fs, this.auditWriter, task, 'Task cancelled before execution').catch((e) => {
          emitMoveFailed(this.auditWriter, {
            fullTaskId: fullId,
            shortTaskId: shortId,
            context: 'cancel_sendFallbackError',
            error: formatErr(e),
          });
        });
      }

      emitCancelled(this.auditWriter, { fullTaskId: fullId, shortTaskId: shortId, from: 'pending' });
    } finally {
      this.cancellingIds.delete(fullId);
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
      fs: this.fs,
      fsFactory: this.fsFactory,
      profile: 'full',
      signal,
      auditWriter: this.auditWriter,
      getElapsedMs: () => 0,
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
    this._signalWork();
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
