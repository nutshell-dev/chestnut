/**
 * TaskSystem - SubAgent task lifecycle management
 * 
 * Manages subagent task queue and execution using directory-based persistence.
 * Uses a pending queue + dispatcher pattern for concurrency control.
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fsSync from 'fs';
import type { FileSystem } from '../../foundation/fs/types.js';

import { JsonlLogger } from '../../foundation/monitor/index.js';
import { SubAgent } from '../subagent/agent.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT_TASKS } from '../../constants.js';
import { ToolRegistryImpl } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/builtins/index.js';
import type { LLMService } from '../../foundation/llm/index.js';
import type { CallerType } from '../tools/caller-type.js';
import { callerTypeToProfile } from '../tools/caller-type.js';
import type { ToolResult, Tool } from '../tools/executor.js';
import type { Message, ToolDefinition } from '../../types/message.js';
import type { OutboxWriter } from '../communication/index.js';
import type { ContractManager } from '../contract/manager.js';
import type { SkillRegistry } from '../skill/registry.js';
import { AuditWriter } from '../../foundation/audit/writer.js';
import type { StreamLog } from '../../foundation/stream/types.js';
import { STREAM_FILE } from '../../foundation/stream/types.js';
import { writeInbox } from '../../foundation/messaging/index.js';
import type { InboxMessage } from '../../types/contract.js';

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
  private monitor: JsonlLogger;
  private registry: ToolRegistryImpl;
  private llm?: LLMService;
  private skillRegistry?: SkillRegistry;
  private contractManager?: ContractManager;
  private outboxWriter?: OutboxWriter;
  private auditWriter?: AuditWriter;
  private parentStreamLog?: StreamLog;

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
  
  // Pending queue for tasks waiting to be executed
  private pendingQueue: Array<SubAgentTask | ToolTask> = [];
  // Store tool callbacks separately (not serializable to disk)
  private pendingCallbacks: Map<string, () => Promise<ToolResult>> = new Map();
  private retryBaseDelayMs: number;

  constructor(
    private clawDir: string,
    private fs: FileSystem,
    options: { maxConcurrent?: number; auditWriter?: AuditWriter; retryBaseDelayMs?: number; parentStreamLog?: StreamLog } = {}
  ) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.auditWriter = options.auditWriter;
    this.parentStreamLog = options.parentStreamLog;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.monitor = new JsonlLogger({ logsDir: path.join(clawDir, 'logs') });
    // Create tool registry for subagents
    this.registry = new ToolRegistryImpl();
    registerBuiltinTools(this.registry);
  }

  async initialize(): Promise<void> {
    // Ensure task directories exist
    await this.fs.ensureDir('tasks/pending');
    await this.fs.ensureDir('tasks/running');
    await this.fs.ensureDir('tasks/done');
    await this.fs.ensureDir('tasks/failed');
    await this.fs.ensureDir('tasks/results');
    await this.fs.ensureDir('inbox/pending');
    
    // Cold-start recovery: load existing pending and running tasks
    await this.recoverTasks();
    
    // Note: startDispatch() should be called after setLLMService() to avoid race conditions
  }

  /**
   * Start dispatching pending tasks.
   * Must be called after setLLMService() for subagent tasks to work correctly.
   */
  startDispatch(): void {
    this._dispatch();
  }

  /**
   * Recover tasks from filesystem on startup
   * - Pending tasks: load into queue
   * - Running tasks: move back to pending (they need to be re-executed)
   */
  private async recoverTasks(): Promise<void> {
    try {
      let recoveredFromRunning = 0;
      // First, move any running tasks back to pending (they were interrupted)
      const runningEntries = await this.fs.list('tasks/running');
      for (const entry of runningEntries) {
        if (entry.name.endsWith('.json')) {
          try {
            const content = await this.fs.read(entry.path);
            const task = JSON.parse(content) as SubAgentTask | ToolTask;
            if (task.kind === 'tool') {
              // callback 已丢失，移动到 failed，不重新执行
              const failedPath = `tasks/failed/${task.id}.json`;
              await this.fs.move(entry.path, failedPath);
              this.monitor.log('task_discarded', {
                taskId: task.id,
                kind: 'tool',
                reason: 'daemon_restarted',
              });
              // 通知 parent，避免永久挂起
              await this.sendFallbackError(task, 'daemon restarted, tool task discarded').catch((e) => {
                this.monitor.log('error', {
                  context: 'recoverTasks.sendFallbackError',
                  taskId: task.id,
                  error: e instanceof Error ? e.message : String(e),
                });
              });
            } else {
              // subagent 任务：检测是否已写出结果
              const resultPath  = `tasks/results/${task.id}/result.txt`;
              const sentMarker  = `tasks/results/${task.id}/result.txt.sent`;
              // 先检查 .sent 标记（表示上次恢复已成功投递，只需清理）
              const alreadySent = await this.fs.exists(sentMarker);
              const resultExists = !alreadySent && await this.fs.exists(resultPath);

              if (alreadySent) {
                // 上次恢复已投递，仅清理 running/ 残留
                await this.fs.move(entry.path, `tasks/done/${task.id}.json`).catch(() => {
                  this.fs.delete(entry.path).catch(() => {});
                });
                this.monitor.log('task_recovered_as_done', {
                  taskId: task.id,
                  reason: 'already_sent',
                });
              } else if (resultExists) {
                // 结果已写出，补发 inbox；成功后写 .sent 标记防止重复投递
                const resultContent = await this.fs.read(resultPath);
                const resultSent = await this.sendResult(task, resultContent, false)
                  .then(() => true)
                  .catch((e) => {
                    this.monitor.log('error', {
                      context: 'recoverTasks.resend_result_failed',
                      taskId: task.id,
                      error: e instanceof Error ? e.message : String(e),
                    });
                    // resend 失败降级：发 fallbackError，parent 知道任务状态
                    this.sendFallbackError(task, 'Result resend failed after recovery').catch(() => {});
                    return false;
                  });
                if (resultSent) {
                  await this.fs.writeAtomic(sentMarker, '1').catch(() => {});
                }
                await this.fs.move(entry.path, `tasks/done/${task.id}.json`).catch(() => {
                  this.fs.delete(entry.path).catch(() => {});
                });
                this.monitor.log('task_recovered_as_done', {
                  taskId: task.id,
                  reason: 'result_file_exists',
                });
              } else {
                // 结果未写出：移回 pending 重新执行（原有逻辑）
                const pendingPath = `tasks/pending/${task.id}.json`;
                await this.fs.move(entry.path, pendingPath);
                this.pendingQueue.push(task);
                recoveredFromRunning++;
                this.monitor.log('task_recovered', {
                  taskId: task.id,
                  kind: task.kind,
                  from: 'running',
                  to: 'pending',
                });
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.monitor.log('error', {
              error: `Failed to recover running task: ${errMsg}`,
              path: entry.path,
            });
          }
        }
      }
      
      // Load pending tasks
      const pendingEntries = await this.fs.list('tasks/pending');
      for (const entry of pendingEntries) {
        if (entry.name.endsWith('.json')) {
          try {
            const content = await this.fs.read(entry.path);
            const task = JSON.parse(content) as SubAgentTask | ToolTask;
            if (task.kind === 'tool') {
              // pending 里的 tool 任务同样 callback 已丢失，移动到 failed
              const failedPath = `tasks/failed/${task.id}.json`;
              await this.fs.move(entry.path, failedPath);
              this.monitor.log('task_discarded', {
                taskId: task.id,
                kind: 'tool',
                reason: 'daemon_restarted',
              });
              // 通知 parent，避免永久挂起
              await this.sendFallbackError(task, 'daemon restarted, tool task discarded').catch((e) => {
                this.monitor.log('error', {
                  context: 'recoverTasks.sendFallbackError_pending',
                  taskId: task.id,
                  error: e instanceof Error ? e.message : String(e),
                });
              });
            } else {
              this.pendingQueue.push(task);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.monitor.log('error', {
              error: `Failed to load pending task: ${errMsg}`,
              path: entry.path,
            });
          }
        }
      }
      
      // Sort pending queue by createdAt to maintain order
      this.pendingQueue.sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      
      // 统计历史失败任务数（仅用于审计，不重新执行）
      const failedEntries = await this.fs.list('tasks/failed').catch(() => []);
      const failedCount = failedEntries.filter(e => e.name.endsWith('.json')).length;
      
      this.monitor.log('task_recovery_complete', {
        pendingCount: this.pendingQueue.length,
        recoveredFromRunning,
        failedCount,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.monitor.log('error', {
        error: `Task recovery failed: ${errMsg}`,
      });
    }
  }

  setLLMService(llm: LLMService): void {
    this.llm = llm;
  }

  setParentStreamLog(sink: StreamLog): void {
    this.parentStreamLog = sink;
  }

  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
  }

  setContractManager(manager: ContractManager): void {
    this.contractManager = manager;
  }

  setOutboxWriter(writer: OutboxWriter): void {
    this.outboxWriter = writer;
  }

  private static readonly PENDING_QUEUE_MAX = 1000;

  /**
   * Schedule a new subagent task
   * Returns taskId immediately, task enters pending queue and will be dispatched
   */
  async scheduleSubAgent(taskData: Omit<SubAgentTask, 'id' | 'createdAt'>): Promise<string> {
    // Max size guard to prevent unbounded queue growth
    if (this.pendingQueue.length >= TaskSystem.PENDING_QUEUE_MAX) {
      throw new Error(`pendingQueue full (${TaskSystem.PENDING_QUEUE_MAX} tasks pending)`);
    }

    const taskId = randomUUID();
    const task: SubAgentTask = {
      ...taskData,
      id: taskId,
      createdAt: new Date().toISOString(),
    };

    // Save to pending directory
    const taskPath = `tasks/pending/${taskId}.json`;
    await this.fs.writeAtomic(taskPath, JSON.stringify(task, null, 2));

    // Add to pending queue
    this.pendingQueue.push(task);

    // Write task_started event to stream
    this.parentStreamLog?.write({
      ts: Date.now(),
      type: 'task_started',
      taskId,
      callerType: taskData.callerType ?? 'subagent',
      silent: false,
    });

    // Log
    this.monitor.log('subagent_scheduled', {
      taskId,
      parentClawId: task.parentClawId,
      maxSteps: task.maxSteps,
      queuePosition: this.pendingQueue.length,
    });
    this.auditWriter?.write('task_scheduled', taskId, 'kind=subagent', `parent=${task.parentClawId}`);

    // Trigger dispatch
    this._dispatch();

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
    const taskPath = `tasks/pending/${taskId}.json`;
    await this.fs.writeAtomic(taskPath, JSON.stringify(task, null, 2));

    // Guard: check queue capacity before registering callback
    if (this.pendingQueue.length >= TaskSystem.PENDING_QUEUE_MAX) {
      throw new Error(`pendingQueue full (${TaskSystem.PENDING_QUEUE_MAX} tasks pending)`);
    }

    // Register callback only after file write succeeds and queue capacity confirmed
    this.pendingCallbacks.set(taskId, executeCallback);
    this.pendingQueue.push(task);

    // Log
    this.monitor.log('tool_task_scheduled', {
      taskId,
      parentClawId,
      toolName,
      queuePosition: this.pendingQueue.length,
    });
    this.auditWriter?.write('task_scheduled', taskId, 'kind=tool', `parent=${parentClawId}`, `tool=${toolName}`);

    // Trigger dispatch
    this._dispatch();

    return taskId;
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
        await this.executeToolTask(task, callback, signal);
      } else {
        await this.executeTask(task, signal);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.monitor.log('error', {
        taskId: task.id,
        error: `Task start/execution failed: ${errorMsg}`,
      });
      // 通知 parent，避免永久挂起
      await this.sendFallbackError(task, `Task failed to start: ${errorMsg}`).catch((e) => {
        this.monitor?.log('error', {
          context: 'sendFallbackError_FAILED',
          taskId: task.id,
          error: e instanceof Error ? e.message : String(e),
        });
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
      `tasks/pending/${taskId}.json`,
      `tasks/running/${taskId}.json`
    );
    this.auditWriter?.write('task_started', taskId);
  }

  /**
   * Execute a task - internal method
   */
  private async executeTask(task: SubAgentTask, signal: AbortSignal): Promise<void> {
    const taskStartTime = Date.now();
    let taskFailed = false;

    // Per-task stream writer setup
    const taskDir = path.join(this.clawDir, 'tasks', 'results', task.id);
    fsSync.mkdirSync(taskDir, { recursive: true });
    const taskAuditWriter = new AuditWriter(this.fs, `tasks/results/${task.id}/audit.tsv`);
    const taskStreamPath = path.join(taskDir, STREAM_FILE);
    let taskStreamFd: number | null = null;
    try {
      taskStreamFd = fsSync.openSync(taskStreamPath, 'a');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.monitor.log('warn', {
          context: 'executeTask.openStream',
          taskId: task.id,
          error: String(err),
        });
      }
    }

    const writeTaskEvent = (event: Record<string, unknown>) => {
      if (taskStreamFd === null) return;
      try {
        fsSync.writeSync(taskStreamFd, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
      } catch (err) {
        this.monitor.log('warn', {
          context: 'executeTask.writeStream',
          taskId: task.id,
          error: String(err),
        });
      }
    };

    // 每次执行开头写分隔标记，方便区分多次尝试
    writeTaskEvent({ type: 'task_attempt_start', taskId: task.id });

    const closeTaskStream = () => {
      if (taskStreamFd !== null) {
        try { fsSync.closeSync(taskStreamFd); } catch {}
        taskStreamFd = null;
      }
    };

    try {
      if (!this.llm) {
        throw new Error('LLM service not set. Call setLLMService() before scheduling tasks.');
      }

      // Filter tools based on task.tools whitelist
      const allowedTools = task.tools.length > 0
        ? this.registry.getAll().filter(t => task.tools.includes(t.name))
        : this.registry.getAll();
      const toolsForLLM = (task.toolsForLLM && task.toolsForLLM.length > 0)
        ? task.toolsForLLM
        : this.registry.formatForLLM(allowedTools);

      // Build per-task registry filtered by caller profile + extraTools
      const subagentProfile = callerTypeToProfile(task.callerType ?? 'subagent');
      const effectiveRegistry = (() => {
        const r = new ToolRegistryImpl();
        for (const t of this.registry.getForProfile(subagentProfile)) r.register(t);
        for (const t of task.extraTools ?? []) r.register(t);
        return r;
      })();

      const subAgent = new SubAgent({
        agentId: task.id,
        prompt: task.prompt,
        clawDir: this.clawDir,
        llm: this.llm,
        registry: effectiveRegistry,
        fs: this.fs,
        monitor: this.monitor,
        maxSteps: task.maxSteps,
        timeoutMs: task.timeout * 1000,
        signal,
        toolsForLLM,
        systemPrompt: task.systemPrompt,
        callerType: task.callerType,
        idleTimeoutMs: task.idleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS,
        messages: task.messages,
        originClawId: task.originClawId,
        taskSystem: this,   // dispatcher 的 spawn 工具需要
        skillRegistry: this.skillRegistry,
        contractManager: this.contractManager,
        outboxWriter: this.outboxWriter,
        taskStreamWriter: { write: writeTaskEvent },
        auditWriter: taskAuditWriter,
      });

      const result = await subAgent.run();

      // Send success result to parent inbox (with onTaskResult handlers)
      let inboxResult = result;
      for (const handler of [...this._taskResultHandlers]) {
        try {
          inboxResult = await handler(task.id, task.callerType, inboxResult, false);
        } catch (handlerErr) {
          this.monitor.log('error', {
            context: 'taskResultHandler_threw',
            taskId: task.id,
            error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
          // inboxResult 保持上一个 handler 的输出，继续后续 handler
        }
      }
      await this.sendResult(task, inboxResult, false);

      this.monitor.log('subagent_completed', {
        taskId: task.id,
        parentClawId: task.parentClawId,
        resultLength: result.length,
      });
      this.auditWriter?.write('task_completed', task.id, 'ok', `ms=${Date.now() - taskStartTime}`);
    } catch (error) {
      taskFailed = true;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // error path 也必须走 handler 循环，确保 removeHandler 等清理逻辑被触发
      let inboxResult = errorMsg;
      for (const handler of [...this._taskResultHandlers]) {
        try {
          inboxResult = await handler(task.id, task.callerType, inboxResult, true);
        } catch (handlerErr) {
          // handler 本身抛异常不影响清理链，继续执行后续 handler
          this.monitor.log('error', {
            context: 'taskResultHandler_threw_on_error_path',
            taskId: task.id,
            error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
        }
      }

      // Send error result to parent inbox
      try {
        await this.sendResult(task, inboxResult, true);
      } catch (sendErr) {
        // sendResult 本身失败：降级写最小通知，确保 parent 不被永远挂起
        await this.sendFallbackError(task, errorMsg).catch((e) => {
          this.monitor?.log('error', {
            context: 'sendFallbackError_FAILED',
            taskId: task.id,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }

      this.monitor.log('error', {
        taskId: task.id,
        parentClawId: task.parentClawId,
        error: errorMsg,
      });
      this.auditWriter?.write('task_completed', task.id, 'err', `ms=${Date.now() - taskStartTime}`);
    } finally {
      // Close task stream
      closeTaskStream();
      // Move from running to done/failed based on success
      if (taskFailed) {
        await this.moveTaskToFailed(task.id);
      } else {
        await this.moveTaskToDone(task.id);
      }
    }
  }

  /**
   * Execute a tool task - internal method
   * Implements retry logic for idempotent tools with exponential backoff
   */
  private async executeToolTask(
    task: ToolTask,
    executeCallback: () => Promise<ToolResult>,
    signal: AbortSignal,
  ): Promise<void> {
    const taskStartTime = Date.now();
    let lastError: string | undefined;
    let success = false;
    const maxAttempts = task.maxRetries + 1; // Initial + retries

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check abort signal before each attempt
      if (signal.aborted) {
        lastError = 'Execution aborted';
        break;
      }

      try {
        const result = await executeCallback();
        // Success - send result and mark success
        try {
          await this.sendToolResult(task, result, false);
        } catch (sendErr) {
          // sendToolResult 本身失败：降级写最小通知，不进入重试（执行已成功）
          await this.sendFallbackError(task, 'Failed to send result').catch((e) => {
            this.monitor?.log('error', {
              context: 'sendFallbackError_FAILED',
              taskId: task.id,
              error: e instanceof Error ? e.message : String(e),
            });
          });
        }
        success = true;
        this.monitor.log('tool_task_completed', {
          taskId: task.id,
          parentClawId: task.parentClawId,
          toolName: task.toolName,
          retriesUsed: attempt,
        });
        this.auditWriter?.write('task_completed', task.id, 'ok', `ms=${Date.now() - taskStartTime}`);
        // tool_async_result：仅当 toolUseId 已记录时写入
        if (task.toolUseId) {
          this.auditWriter?.write('tool_async_result', task.toolName, task.toolUseId, `task=${task.id}`);
        }
        break; // Exit retry loop on success
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = errorMsg;

        // Check if we should retry
        if (attempt < task.maxRetries) {
          // Update retry count in task and persist to running file
          task.retryCount = attempt + 1;
          try {
            await this.fs.writeAtomic(
              `tasks/running/${task.id}.json`,
              JSON.stringify(task, null, 2)
            );
          } catch (writeErr) {
            // Non-critical: just log
            this.monitor.log('error', {
              taskId: task.id,
              error: `Failed to update retry count: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
            });
          }

          this.monitor.log('tool_task_retry', {
            taskId: task.id,
            toolName: task.toolName,
            parentClawId: task.parentClawId,
            attempt: attempt + 1,
            maxRetries: task.maxRetries,
            error: errorMsg,
          });

          // Exponential backoff: retryBaseDelayMs, retryBaseDelayMs*2, etc.
          const backoffMs = this.retryBaseDelayMs * (attempt + 1);
          await new Promise(r => setTimeout(r, backoffMs));
          
          // Check abort signal after sleep
          if (signal.aborted) {
            lastError = 'Execution aborted during retry wait';
            break;
          }
        }
        // Continue to next retry attempt
      }
    }

    // If not successful after all attempts, send error result
    if (!success) {
      const finalError = lastError || 'Unknown error';
      try {
        await this.sendToolResult(
          task,
          task.maxRetries > 0 
            ? `Execution failed after ${task.retryCount} retries: ${finalError}`
            : finalError,
          true
        );
      } catch (sendErr) {
        // sendToolResult 失败：降级写最小通知
        await this.sendFallbackError(task, finalError).catch((e) => {
          this.monitor?.log('error', {
            context: 'sendFallbackError_FAILED',
            taskId: task.id,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }

      this.monitor.log('error', {
        taskId: task.id,
        parentClawId: task.parentClawId,
        toolName: task.toolName,
        error: finalError,
        retriesExhausted: task.maxRetries > 0,
      });
      this.auditWriter?.write('task_completed', task.id, 'err', `ms=${Date.now() - taskStartTime}`);
    }

    // Move from running to done/failed based on success
    if (success) {
      await this.moveTaskToDone(task.id);
    } else {
      await this.moveTaskToFailed(task.id);
    }
  }

  /**
   * Send tool task result to parent claw's inbox
   * Large outputs are offloaded to tasks/results/{taskId}.txt
   * Writes directly to inbox/pending/ in .md format (standard inbox format)
   */
  private async sendToolResult(task: ToolTask, result: ToolResult | string, isError: boolean): Promise<void> {
    const fullContent = typeof result === 'string' ? result : result.content;
    
    // Try to write full result to tasks/results/
    let resultRef: string | undefined;
    try {
      const resultPath = `tasks/results/${task.id}/result.txt`;
      await this.fs.ensureDir(`tasks/results/${task.id}`);
      await this.fs.writeAtomic(resultPath, fullContent);
      resultRef = resultPath;
    } catch (writeErr) {
      // Degrade gracefully: resultRef remains undefined, send full content in inbox
      const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.monitor.log('error', {
        taskId: task.id,
        parentClawId: task.parentClawId,
        error: `Failed to write result to file: ${errMsg}`,
      });
    }

    // Build summary (preview if resultRef exists, full content otherwise)
    const summary = resultRef ? fullContent.slice(0, 500) : fullContent;

    // Pre-compute both versions of message content (ref and inline)
    const inlineContent = JSON.stringify({
      taskId: task.id,
      toolName: task.toolName,
      result: fullContent,
      is_error: isError,
    });
    const messageContent = resultRef
      ? JSON.stringify({
          taskId: task.id,
          toolName: task.toolName,
          summary,
          resultRef,
          is_error: isError,
        })
      : inlineContent;

    const msgId = randomUUID();
    const priority: 'high' | 'normal' = isError ? 'high' : 'normal';
    const baseMsg: InboxMessage = {
      id: msgId,
      type: 'message',
      from: task.callerType ?? 'task_system',
      to: task.parentClawId,
      content: messageContent,
      priority,
      timestamp: new Date().toISOString(),
    };

    try {
      await writeInbox(this.fs, 'inbox/pending', baseMsg);
    } catch (err) {
      if (resultRef) {
        // inbox 写失败：删除孤立的 results 文件，降级为 inline 内容重试
        await this.fs.delete(resultRef).catch((delErr) => {
          this.monitor.log('warn', {
            context: 'sendToolResult.orphan_result_delete_failed',
            taskId: task.id,
            resultRef,
            error: delErr instanceof Error ? delErr.message : String(delErr),
          });
        });
        try {
          await writeInbox(this.fs, 'inbox/pending', { ...baseMsg, content: inlineContent });
          return;
        } catch {
          // 降级也失败，继续抛出原始错误
        }
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[task] Failed to write inbox message for tool task ${task.id}:`, err);
      this.monitor.log('error', {
        taskId: task.id,
        parentClawId: task.parentClawId,
        error: `Failed to write inbox message: ${errMsg}`,
      });
      throw err;  // Re-throw to allow caller fallback
    }
  }

  /**
   * Send task result to parent claw's inbox
   * Large outputs are offloaded to tasks/results/{taskId}.txt
   */
  private async sendResult(task: SubAgentTask, result: string, isError: boolean): Promise<void> {
    // Try to write full result to tasks/results/
    let resultRef: string | undefined;
    try {
      const resultPath = `tasks/results/${task.id}/result.txt`;
      await this.fs.ensureDir(`tasks/results/${task.id}`);
      await this.fs.writeAtomic(resultPath, result);
      resultRef = resultPath;
    } catch (writeErr) {
      // Degrade gracefully: resultRef remains undefined, send full content in inbox
      const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.monitor.log('error', {
        taskId: task.id,
        parentClawId: task.parentClawId,
        error: `Failed to write result to file: ${errMsg}`,
      });
    }

    // Build summary (preview if resultRef exists, full content otherwise)
    const summary = resultRef ? result.slice(0, 500) : result;

    // Pre-compute both versions of message content (ref and inline)
    const inlineContent = JSON.stringify({
      taskId: task.id,
      result,
      is_error: isError,
    });
    const messageContent = resultRef
      ? JSON.stringify({
          taskId: task.id,
          summary,
          resultRef,
          is_error: isError,
        })
      : inlineContent;

    const msgId = randomUUID();
    const priority: 'high' | 'normal' = isError ? 'high' : 'normal';
    const baseMsg: InboxMessage = {
      id: msgId,
      type: 'message',
      from: task.callerType ?? 'subagent',
      to: task.parentClawId,
      content: messageContent,
      priority,
      timestamp: new Date().toISOString(),
    };

    try {
      await writeInbox(this.fs, 'inbox/pending', baseMsg);
    } catch (err) {
      if (resultRef) {
        // inbox 写失败：删除孤立的 results 文件，降级为 inline 内容重试
        await this.fs.delete(resultRef).catch((delErr) => {
          this.monitor.log('warn', {
            context: 'sendResult.orphan_result_delete_failed',
            taskId: task.id,
            resultRef,
            error: delErr instanceof Error ? delErr.message : String(delErr),
          });
        });
        try {
          await writeInbox(this.fs, 'inbox/pending', { ...baseMsg, content: inlineContent });
          return;
        } catch {
          // 降级也失败，继续抛出原始错误
        }
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[task] Failed to write inbox message for task ${task.id}:`, err);
      this.monitor.log('error', {
        taskId: task.id,
        parentClawId: task.parentClawId,
        error: `Failed to write inbox message: ${errMsg}`,
      });
      throw err;  // Re-throw to allow caller fallback
    }
  }

  /**
   * Send fallback error message directly to inbox (bypassing results file)
   * Used when sendResult fails to ensure parent is not left hanging
   */
  private async sendFallbackError(task: SubAgentTask | ToolTask, errorMsg: string): Promise<void> {
    const msgId = randomUUID();
    const msg: InboxMessage = {
      id: msgId,
      type: 'message',
      from: task.callerType ?? 'task_system',
      to: task.parentClawId,
      content: JSON.stringify({ taskId: task.id, is_error: true, result: `Task failed: ${errorMsg}` }),
      priority: 'high',
      timestamp: new Date().toISOString(),
    };
    await writeInbox(this.fs, 'inbox/pending', msg);
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
      this.monitor.log('error', { taskId, error: errMsg });
      // 删除 running 文件防止重启后重复执行，丢失记录好过重复副作用
      await this.fs.delete(`tasks/running/${taskId}.json`).catch((e) => {
        this.monitor.log('error', { taskId, context: 'moveTaskToDone.delete', error: e instanceof Error ? e.message : String(e) });
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
      this.monitor.log('error', { taskId, error: errMsg });
      await this.fs.delete(`tasks/running/${taskId}.json`).catch((e) => {
        this.monitor.log('error', { taskId, context: 'moveTaskToFailed.delete', error: e instanceof Error ? e.message : String(e) });
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
   * List pending task IDs (for testing/monitoring)
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
      this.monitor.log('info', { event: 'task_cancelled', taskId, from: 'running' });
      return;
    }

    // 2. 再检查 pending queue
    const pendingIdx = this.pendingQueue.findIndex(t => t.id === taskId);
    if (pendingIdx !== -1) {
      const task = this.pendingQueue[pendingIdx];
      this.pendingQueue.splice(pendingIdx, 1);

      // 清理 tool callback
      this.pendingCallbacks.delete(taskId);

      // 文件：pending → failed
      await this.fs.move(
        `tasks/pending/${taskId}.json`,
        `tasks/failed/${taskId}.json`
      ).catch((e) => {
        this.monitor.log('error', {
          context: 'cancel_pending.move_failed',
          taskId,
          error: e instanceof Error ? e.message : String(e),
        });
      });

      // tool 任务：通知 parent
      if (task.kind === 'tool') {
        await this.sendFallbackError(task, 'Task cancelled before execution').catch((e) => {
          this.monitor.log('error', {
            context: 'cancel_pending.sendFallbackError',
            taskId,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }

      this.monitor.log('info', { event: 'task_cancelled', taskId, from: 'pending' });
      return;
    }

    // 3. 找不到
    throw new Error(`Task ${taskId} not found in running or pending`);
  }

  /**
   * Shutdown - wait for all tasks to complete or timeout
   */
  async shutdown(timeoutMs: number = 30000): Promise<void> {
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
        console.warn('[task] Shutdown timeout, some tasks may not have stopped');
      });
    }

    this.runningTasks.clear();
    this.pendingQueue = [];
    this.pendingCallbacks.clear();
    await this.monitor.close();
  }
}
