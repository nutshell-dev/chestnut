import * as path from 'path';
import * as fsSync from 'fs';
import type { FileSystem } from '../../foundation/fs/types.js';
import { AuditWriter, createAuditWriter } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { StreamLog } from '../../foundation/stream/types.js';
import { STREAM_FILE } from '../../foundation/stream/types.js';
import type { CallerType } from '../tools/caller-type.js';
import { callerTypeToProfile } from '../tools/caller-type.js';
import { ToolRegistryImpl } from '../tools/registry.js';
import { createSubAgent } from '../subagent/index.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../constants.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { sendResult, sendFallbackError } from './result-delivery.js';

import type { SubAgentTask } from './system.js';
import type { TaskSystem } from './system.js';


/** M9: 闭包 ≥ 6 依赖 → deps interface */
export interface SubAgentExecutionDeps {
  fs: FileSystem;
  auditWriter: AuditWriter;
  llm: LLMOrchestrator;
  registry: ToolRegistryImpl;
  clawDir: string;
  parentStreamLog?: StreamLog;
  taskResultHandlers: Array<
    (taskId: string, callerType: CallerType | undefined, result: string, isError: boolean) => Promise<string>
  >;
  moveTaskToDone: (taskId: string) => Promise<void>;
  moveTaskToFailed: (taskId: string) => Promise<void>;
  taskSystem: TaskSystem;
}

/**
 * Execute a subagent task
 */
export async function executeSubAgentTask(
  task: SubAgentTask,
  signal: AbortSignal,
  deps: SubAgentExecutionDeps,
): Promise<void> {
  const { fs, auditWriter, llm, registry, clawDir, parentStreamLog, taskResultHandlers, moveTaskToDone, moveTaskToFailed, taskSystem } = deps;
  const taskStartTime = Date.now();
  let taskFailed = false;

  // Per-task stream writer setup
  const taskDir = path.join(clawDir, 'tasks', 'results', task.id);
  fsSync.mkdirSync(taskDir, { recursive: true });
  const taskAuditWriter = createAuditWriter(fs, `tasks/results/${task.id}/audit.tsv`);
  const taskStreamPath = path.join(taskDir, STREAM_FILE);
  let taskStreamFd: number | null = null;
  try {
    taskStreamFd = fsSync.openSync(taskStreamPath, 'a');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      auditWriter?.write(TASK_AUDIT_EVENTS.STREAM_FAILED, task.id, 'context=openStream', `code=${code}`);
    }
  }

  const writeTaskEvent = (event: Record<string, unknown>) => {
    if (taskStreamFd === null) return;
    try {
      fsSync.writeSync(taskStreamFd, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
    } catch (err) {
      auditWriter?.write(TASK_AUDIT_EVENTS.STREAM_FAILED, task.id, 'context=writeStream', `error=${err instanceof Error ? err.message : JSON.stringify(err)}`);
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
    // LLM is guaranteed by constructor (readonly non-null field)

    // Filter tools based on task.tools whitelist
    const allowedTools = task.tools.length > 0
      ? registry.getAll().filter(t => task.tools.includes(t.name))
      : registry.getAll();
    const toolsForLLM = (task.toolsForLLM && task.toolsForLLM.length > 0)
      ? task.toolsForLLM
      : registry.formatForLLM(allowedTools);

    // Build per-task registry filtered by caller profile + extraTools
    const subagentProfile = callerTypeToProfile(task.callerType ?? 'subagent');
    const effectiveRegistry = (() => {
      const r = new ToolRegistryImpl();
      for (const t of registry.getForProfile(subagentProfile)) r.register(t);
      for (const t of task.extraTools ?? []) r.register(t);
      return r;
    })();

    const subAgent = createSubAgent({
      agentId: task.id,
      prompt: task.prompt,
      clawDir,
      llm,
      registry: effectiveRegistry,
      fs,
      maxSteps: task.maxSteps,
      timeoutMs: task.timeout * 1000,
      signal,
      toolsForLLM,
      systemPrompt: task.systemPrompt,
      callerType: task.callerType,
      idleTimeoutMs: task.idleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS,
      messages: task.messages,
      originClawId: task.originClawId,
      taskSystem,   // dispatcher 的 spawn 工具需要
      taskStreamWriter: { write: writeTaskEvent },
      auditWriter: taskAuditWriter,
    });

    const result = await subAgent.run();

    // Send success result to parent inbox (with onTaskResult handlers)
    let inboxResult = result;
    for (const handler of [...taskResultHandlers]) {
      try {
        inboxResult = await handler(task.id, task.callerType, inboxResult, false);
      } catch (handlerErr) {
        auditWriter?.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=handler_threw', `error=${handlerErr instanceof Error ? handlerErr.message : JSON.stringify(handlerErr)}`);
        // inboxResult 保持上一个 handler 的输出，继续后续 handler
      }
    }
    await sendResult(fs, auditWriter, task, inboxResult, false);

    auditWriter?.write('task_completed', task.id, 'ok', `ms=${Date.now() - taskStartTime}`, `len=${result.length}`);
  } catch (error) {
    taskFailed = true;
    const errorMsg = error instanceof Error ? error.message : String(error);

    // error path 也必须走 handler 循环，确保 removeHandler 等清理逻辑被触发
    let inboxResult = errorMsg;
    for (const handler of [...taskResultHandlers]) {
      try {
        inboxResult = await handler(task.id, task.callerType, inboxResult, true);
      } catch (handlerErr) {
        // handler 本身抛异常不影响清理链，继续执行后续 handler
        auditWriter?.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=handler_threw_error_path', `error=${handlerErr instanceof Error ? handlerErr.message : JSON.stringify(handlerErr)}`);
      }
    }

    // Send error result to parent inbox
    try {
      await sendResult(fs, auditWriter, task, inboxResult, true);
    } catch (sendErr) {
      // sendResult 本身失败：降级写最小通知，确保 parent 不被永远挂起
      await sendFallbackError(fs, auditWriter, task, errorMsg).catch((e) => {
        auditWriter?.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=sendFallbackError', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
      });
    }

    auditWriter?.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, `parent=${task.parentClawId}`, `error=${errorMsg}`);
    auditWriter?.write('task_completed', task.id, 'err', `ms=${Date.now() - taskStartTime}`);
  } finally {
    // Close task stream
    closeTaskStream();
    // Move from running to done/failed based on success
    if (taskFailed) {
      await moveTaskToFailed(task.id);
    } else {
      await moveTaskToDone(task.id);
    }
  }
}
