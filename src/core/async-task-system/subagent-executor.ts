import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { type AuditLog, createAuditWriter } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { type StreamLog, STREAM_FILE } from '../../foundation/stream/index.js';
import { type CallerType, callerTypeToProfile } from '../../foundation/tool-protocol/index.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import { createSubAgent } from '../subagent/index.js';
import { createDialogStore } from '../../foundation/dialog-store/index.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../constants.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { STREAM_TASK_EVENTS } from './stream-events.js';
import { formatErr, auditError } from './_helpers.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_SUBAGENTS_DIR, TASKS_SYNC_DIR } from '../../types/paths.js';
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
  let subagentWorkspaceDir: string | undefined;  // phase 515 / function scope for finally cleanup

  // Per-task stream writer setup（fd-less / appendSync 模式）
  const taskResultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;   // 相对 clawDir / fs baseDir
  fs.ensureDirSync(taskResultDir);
  const taskAuditWriter = createAuditWriter(fs, `${taskResultDir}/audit.tsv`);
  const taskStreamRelPath = `${taskResultDir}/${STREAM_FILE}`;

  const writeTaskEvent = (event: Record<string, unknown>) => {
    try {
      fs.appendSync(taskStreamRelPath, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
    } catch (err) {
      auditWriter.write(TASK_AUDIT_EVENTS.STREAM_FAILED, task.id, 'context=writeStream', `error=${formatErr(err)}`);
    }
  };

  // 每次执行开头写分隔标记，方便区分多次尝试
  writeTaskEvent({ type: STREAM_TASK_EVENTS.TASK_ATTEMPT_START, taskId: task.id });

  try {
    // LLM is guaranteed by constructor (readonly non-null field)

    // Build per-task registry filtered by caller profile + extraTools
    const subagentProfile = callerTypeToProfile(task.callerType ?? 'subagent');
    const effectiveRegistry = (() => {
      const r = createToolRegistry();
      for (const t of registry.getForProfile(subagentProfile)) r.register(t);
      for (const t of task.extraTools ?? []) r.register(t);
      return r;
    })();

    const toolsForLLM = registry.formatForLLM(effectiveRegistry.getAll());

    // phase 512: per-subagent workspace dir
    subagentWorkspaceDir = path.join(clawDir, TASKS_SUBAGENTS_DIR, task.id);
    await fs.ensureDir(subagentWorkspaceDir);
    const promptPrefix = buildSubagentSystemPromptPrefix({
      taskId: task.id,
      callerClawId: task.parentClawId,
    });
    const finalSystemPrompt = `${promptPrefix}\n\n${task.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT}`;

    const subAgent = createSubAgent({
      agentId: task.id,
      resultDir: `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`,
      messageStore: createDialogStore(           // ephemeral DialogStore / 0 clawId / 0 archive 触发
        fs,
        `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`,             // baseDir = resultDir
        taskAuditWriter,                         // per-task audit writer
        'messages.json',                         // filename 必填
        '',                                      // phase 470: systemPrompt 由 SubAgent 内部 DEFAULT_SUBAGENT_SYSTEM_PROMPT 提供
      ),
      prompt: task.intent,
      clawDir,
      syncDir: path.join(clawDir, TASKS_SYNC_DIR),
      llm,
      registry: effectiveRegistry,
      fs,
      maxSteps: task.maxSteps,
      timeoutMs: task.timeoutMs,
      signal,
      toolsForLLM,
      callerType: task.callerType,
      originClawId: task.originClawId,
      mainDialogStore,
      mainContextSnapshot: task.mainContextSnapshot,
      workspaceDir: path.join(clawDir, 'clawspace'),   // phase 518: 共享 caller workspace（subagents/<id>/ 改建议性临时区 / 仍 ensureDir + cleanup）
      systemPrompt: finalSystemPrompt,       // phase 512
      callerClawId: task.parentClawId,       // phase 514
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
          auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=postProcessor_threw', `error=${formatErr(handlerErr)}`);
        }
      } else {
        auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=postProcessor_not_found', `name=${task.postProcessor}`);
      }
    }
    await sendResult(fs, auditWriter, task, inboxResult, false);

    auditWriter.write(TASK_AUDIT_EVENTS.TASK_COMPLETED, task.id, 'ok', `ms=${Date.now() - taskStartTime}`, `len=${result.length}`);
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
    auditWriter.write(TASK_AUDIT_EVENTS.TASK_COMPLETED, task.id, 'err', `ms=${Date.now() - taskStartTime}`);
  } finally {
    // Move from running to done/failed based on success
    if (taskFailed) {
      await moveTaskToFailed(task.id);
    } else {
      await moveTaskToDone(task.id);
    }

    // phase 515 / cleanup subagent workspace dir（best-effort 软降级 / 失败 audit 不抛）
    if (subagentWorkspaceDir) {
      await fs.removeDir(subagentWorkspaceDir).catch((cleanupErr) => {
        auditWriter.write(
          TASK_AUDIT_EVENTS.SUBAGENT_WORKSPACE_CLEANUP_FAILED,
          task.id,
          `dir=${subagentWorkspaceDir}`,
          `error=${formatErr(cleanupErr)}`,
        );
      });
    }
  }
}
