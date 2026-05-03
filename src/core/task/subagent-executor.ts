import * as path from 'path';
import * as fsSync from 'fs';
import type { FileSystem } from '../../foundation/fs/types.js';
import { AuditWriter, createAuditWriter } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { StreamLog } from '../../foundation/stream/types.js';
import { STREAM_FILE } from '../../foundation/stream/types.js';
import type { CallerType } from '../../foundation/tool-protocol/caller-type.js';
import { callerTypeToProfile } from '../../foundation/tool-protocol/caller-type.js';
import { ToolRegistryImpl } from '../../foundation/tools/registry.js';
import { createSubAgent } from '../subagent/index.js';
import { createDialogStore } from '../../foundation/dialog-store/index.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../constants.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { sendResult, sendFallbackError } from './result-delivery.js';

import type { PostProcessor } from './post-processors/types.js';
import type { SubAgentTask } from './system.js';


/** M9: 闭包 ≥ 6 依赖 → deps interface */
export interface SubAgentExecutionDeps {
  fs: FileSystem;
  auditWriter: AuditWriter;
  llm: LLMOrchestrator;
  registry: ToolRegistryImpl;
  clawDir: string;
  parentStreamLog?: StreamLog;
  postProcessors: Map<string, PostProcessor>;
  moveTaskToDone: (taskId: string) => Promise<void>;
  moveTaskToFailed: (taskId: string) => Promise<void>;
}

/**
 * Execute a subagent task
 */
export async function executeSubAgentTask(
  task: SubAgentTask,
  signal: AbortSignal,
  deps: SubAgentExecutionDeps,
): Promise<void> {
  const { fs, auditWriter, llm, registry, clawDir, parentStreamLog, postProcessors, moveTaskToDone, moveTaskToFailed } = deps;
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
      resultDir: `tasks/results/${task.id}`,                      // phase443: TaskSystem own 字符串约定
      messageStore: createDialogStore(           // phase453: ephemeral DialogStore 装配 / 0 clawId / 0 archive 触发
        fs,
        `tasks/results/${task.id}`,             // baseDir = resultDir
        taskAuditWriter,                         // per-task audit writer
        'messages.json',                         // filename 必填
      ),
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

      taskStreamWriter: { write: writeTaskEvent },
      auditWriter: taskAuditWriter,
    });

    const result = await subAgent.run();

    // Phase438: 单 postProcessor lookup + execute（替代 pipeline）
    let inboxResult = result;
    if (task.postProcessor) {
      const handler = postProcessors.get(task.postProcessor);
      if (handler) {
        try {
          inboxResult = await handler(inboxResult, task, false, fs, auditWriter);
        } catch (handlerErr) {
          auditWriter?.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=postProcessor_threw', `error=${handlerErr instanceof Error ? handlerErr.message : JSON.stringify(handlerErr)}`);
        }
      } else {
        auditWriter?.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=postProcessor_not_found', `name=${task.postProcessor}`);
      }
    }
    await sendResult(fs, auditWriter, task, inboxResult, false);

    auditWriter?.write('task_completed', task.id, 'ok', `ms=${Date.now() - taskStartTime}`, `len=${result.length}`);
  } catch (error) {
    taskFailed = true;
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Phase438: error path 同型替换
    let inboxResult = errorMsg;
    if (task.postProcessor) {
      const handler = postProcessors.get(task.postProcessor);
      if (handler) {
        try {
          inboxResult = await handler(errorMsg, task, true, fs, auditWriter);
        } catch (handlerErr) {
          auditWriter?.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=postProcessor_threw_error_path', `error=${handlerErr instanceof Error ? handlerErr.message : JSON.stringify(handlerErr)}`);
        }
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
