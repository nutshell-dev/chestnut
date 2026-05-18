import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { type StreamLog, STREAM_FILE } from '../../foundation/stream/index.js';
import { type CallerType, callerTypeToProfile } from '../../foundation/tool-protocol/index.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import { runSubagent, NoopAuditWriter, createDoneTool, DONE_TOOL_NAME } from '../subagent/index.js';
import { createDialogStore } from '../../foundation/dialog-store/index.js';

import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { STREAM_TASK_EVENTS } from './stream-events.js';
import { formatErr, auditError, classifyTaskError } from './_helpers.js';
import { AskMotionTool } from './tools/ask-motion.js';
import { TASKS_SYNC_DIR } from '../../types/paths.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_SUBAGENTS_DIR } from './dirs.js';
import { buildSubagentSystemPromptPrefix, DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../prompts/subagent.js';
import { sendResult, sendFallbackError } from './result-delivery.js';

import type { PostProcessor } from './post-processors/types.js';
import type { SubAgentTask } from './system.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';


/** M9: 闭包 ≥ 6 依赖 → deps interface */
export interface ExecuteSubAgentTaskDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  llm: LLMOrchestrator;
  registry: ToolRegistry;
  clawDir: string;
  parentStreamLog?: StreamLog;
  postProcessors: Map<string, PostProcessor>;
  mainDialogStore?: DialogStore;
  moveTaskToDone: (taskId: string) => Promise<void>;
  moveTaskToFailed: (taskId: string) => Promise<void>;
  toolTimeoutMs?: number;
}

/**
 * Execute a subagent task
 */
export async function executeSubAgentTask(
  task: SubAgentTask,
  signal: AbortSignal,
  deps: ExecuteSubAgentTaskDeps,
): Promise<void> {
  const { fs, auditWriter, llm, registry, clawDir, parentStreamLog, postProcessors, mainDialogStore, moveTaskToDone, moveTaskToFailed } = deps;
  const taskStartTime = Date.now();
  let taskFailed = false;

  // Per-task result dir + TASK_ATTEMPT_START stream marker（async 特有 lifecycle）
  const taskResultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
  fs.ensureDirSync(taskResultDir);
  const taskStreamPath = `${taskResultDir}/${STREAM_FILE}`;
  try {
    fs.appendSync(taskStreamPath, JSON.stringify({
      ts: Date.now(),
      type: STREAM_TASK_EVENTS.TASK_ATTEMPT_START,
      taskId: task.id,
    }) + '\n');
  } catch (err) {
    auditWriter.write(TASK_AUDIT_EVENTS.STREAM_FAILED, task.id, 'context=writeStream', `error=${formatErr(err)}`);
  }

  try {
    // LLM is guaranteed by constructor (readonly non-null field)

    // Build per-task registry filtered by caller profile + motionClawDir 重建
    const subagentProfile = callerTypeToProfile(task.callerType ?? 'subagent');
    const effectiveRegistry = (() => {
      const r = createToolRegistry();
      for (const t of registry.getForProfile(subagentProfile)) {
        if (t.name === DONE_TOOL_NAME) continue; // phase 944: skip main shared done (mirror phase 780)
        r.register(t);
      }
      r.register(createDoneTool()); // fresh done instance per subagent task (mirror phase 780)

      // phase 713: motionClawDir 构造 motionDialogStore + AskMotionTool（全然一致性 reuse）
      if (task.motionClawDir) {
        const motionDialogStore = createDialogStore(
          fs,
          task.motionClawDir,
          new NoopAuditWriter(),  // ask_motion 不 own motion audit
          'current.json',
        );
        const askMotion = new AskMotionTool(llm, motionDialogStore);
        r.register(askMotion);
      }

      return r;
    })();

    const toolsForLLM = registry.formatForLLM(effectiveRegistry.getAll());

    const promptPrefix = buildSubagentSystemPromptPrefix({
      taskId: task.id,
      callerClawId: task.parentClawId,
      subagentsDir: TASKS_SUBAGENTS_DIR,
    });
    const finalSystemPrompt = `${promptPrefix}\n\n${task.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT}`;

    const { text: result } = await runSubagent({
      agentId: task.id,
      callerType: task.callerType,
      callerClawId: task.parentClawId,
      clawDir,
      fs,
      llm,
      registry: effectiveRegistry,
      prompt: task.intent,
      systemPrompt: finalSystemPrompt,
      resultDir: taskResultDir,
      maxSteps: task.maxSteps,
      signal,
      mainDialogStore,
      mainContextSnapshot: task.mainContextSnapshot,
      toolsForLLM,
      timeoutMs: task.timeoutMs,
      originClawId: task.originClawId,
      toolTimeoutMs: deps.toolTimeoutMs,
    });

    // Phase438: 单 postProcessor lookup + execute（替代 pipeline）
    let inboxResult = result;
    if (task.postProcessor) {
      const handler = postProcessors.get(task.postProcessor);
      if (handler) {
        try {
          inboxResult = await handler(inboxResult, task, false, fs, auditWriter);
        } catch (handlerErr) {
          auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=postProcessor_threw', `error=${formatErr(handlerErr)}`);
        }
      } else {
        auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=postProcessor_not_found', `name=${task.postProcessor}`);
      }
    }
    await sendResult(fs, auditWriter, task, inboxResult, false);

    auditWriter.write(
      TASK_AUDIT_EVENTS.TASK_COMPLETED,
      task.id, 'ok',
      `kind=subagent`,
      `parent=${task.parentClawId}`,
      `callerType=${task.callerType ?? 'subagent'}`,
      `intent=${task.intent.slice(0, 60)}`,
      `elapsed_ms=${Date.now() - taskStartTime}`,
      `len=${result.length}`,
    );
  } catch (error) {
    taskFailed = true;
    const errorMsg = formatErr(error);

    // Phase438: error path 同型替换
    let inboxResult = errorMsg;
    if (task.postProcessor) {
      const handler = postProcessors.get(task.postProcessor);
      if (handler) {
        try {
          inboxResult = await handler(errorMsg, task, true, fs, auditWriter);
        } catch (handlerErr) {
          auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=postProcessor_threw_error_path', `error=${formatErr(handlerErr)}`);
        }
      }
    }

    // Send error result to parent inbox
    try {
      await sendResult(fs, auditWriter, task, inboxResult, true);
    } catch (sendErr) {
      // sendResult 本身失败：降级写最小通知，确保 parent 不被永远挂起
      await sendFallbackError(fs, auditWriter, task, errorMsg).catch((e) => {
        auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=sendFallbackError', `error=${formatErr(e)}`);
      });
    }

    auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, `parent=${task.parentClawId}`, `error=${errorMsg}`);
    auditWriter.write(
      TASK_AUDIT_EVENTS.TASK_COMPLETED,
      task.id, 'err',
      `kind=subagent`,
      `parent=${task.parentClawId}`,
      `callerType=${task.callerType ?? 'subagent'}`,
      `intent=${task.intent.slice(0, 60)}`,
      `error_category=${classifyTaskError(error)}`,
      `elapsed_ms=${Date.now() - taskStartTime}`,
    );
  } finally {
    // Move from running to done/failed based on success
    if (taskFailed) {
      await moveTaskToFailed(task.id);
    } else {
      await moveTaskToDone(task.id);
    }
  }
}
