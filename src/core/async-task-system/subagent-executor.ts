import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { type StreamLog, STREAM_FILE, createPerResourceStreamWriter } from '../../foundation/stream/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';
import { callerTypeToProfile } from '../permissions/caller-types.js';

import { applyRestrictedOverrides, type ToolRegistry } from '../../foundation/tools/index.js';
import { runSubagent as defaultRunSubagent, NoopAuditWriter, createPerTaskRegistry, DONE_TOOL_NAME, getDisplayResult } from '../subagent/index.js';
import { createDialogStore, CURRENT_DIALOG_FILE } from '../../foundation/dialog-store/index.js';

import { STREAM_TASK_EVENTS } from './stream-events.js';
import { formatErr, classifyTaskError } from './_helpers.js';
import {
  emitTaskCompleted,
  emitHandlerFailed,
  emitResultDeliveryFailed,
} from './audit-emit.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_SUBAGENTS_DIR, TASKS_SYNC_DIR } from './dirs.js';
import * as nodePath from 'path';

import { buildSubagentSystemPrompt, DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../templates/prompts/index.js';
import { sendResult, sendFallbackError } from './result-delivery.js';

import type { Tool } from '../../foundation/tools/index.js';
import type { PostProcessor } from './post-processors/types.js';
import type { SubAgentTask, FullTaskId } from './types.js';
import { deriveShortIdFromTaskId } from './types.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import type { TaskId } from './types.js';





/** M9: 闭包 ≥ 6 依赖 → deps interface */
interface ExecuteSubAgentTaskDeps {
  fs: FileSystem;
  fsFactory: (baseDir: string) => FileSystem;
  auditWriter: AuditLog;
  llm: LLMOrchestrator;
  registry: ToolRegistry;
  clawDir: string;
  parentStreamLog?: StreamLog;
  postProcessors: Map<string, PostProcessor>;
  mainDialogStore?: DialogStore;
  moveTaskToDone: (taskId: TaskId) => Promise<void>;
  moveTaskToFailed: (taskId: TaskId) => Promise<void>;
  toolTimeoutMs?: number;
  permissionChecker?: PermissionChecker;
  // NEW phase 1369: AskMotionTool factory inject (per phase 619 caller DIP enforce template / cut async-task→summon reverse)
  askMotionToolFactory: (llm: LLMOrchestrator, motionDialogStore: DialogStore) => Tool;
  runSubagent?: typeof defaultRunSubagent;
}

async function applyPostProcessor(
  input: string,
  task: SubAgentTask,
  isError: boolean,
  postProcessors: Map<string, PostProcessor>,
  fs: FileSystem,
  auditWriter: AuditLog,
): Promise<string> {
  if (!task.postProcessor) return input;
  const handler = postProcessors.get(task.postProcessor);
  if (!handler) {
    emitHandlerFailed(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: deriveShortIdFromTaskId(task.id),
      context: 'postProcessor_not_found',
      name: task.postProcessor,
    });
    return input;
  }
  try {
    return await handler(input, task, isError, fs, auditWriter);
  } catch (handlerErr) {
    const ctx = isError ? 'postProcessor_threw_error_path' : 'postProcessor_threw';
    emitHandlerFailed(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: deriveShortIdFromTaskId(task.id),
      context: ctx,
      error: formatErr(handlerErr),
    });
    return input;
  }
}

/**
 * Execute a subagent task
 */
export async function executeSubAgentTask(
  task: SubAgentTask,
  signal: AbortSignal,
  deps: ExecuteSubAgentTaskDeps,
): Promise<void> {
  const { fs, fsFactory, auditWriter, llm, registry, clawDir, parentStreamLog, postProcessors, moveTaskToDone, moveTaskToFailed } = deps;
  const taskStartTime = Date.now();
  let taskFailed = false;

  // Per-task result dir + TASK_ATTEMPT_START stream marker（async 特有 lifecycle）
  const taskResultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
  fs.ensureDirSync(taskResultDir);
  // task_started emitted here (after dir exists) so viewport per-task reader won't ENOENT
  parentStreamLog?.write({
    ts: Date.now(),
    type: STREAM_TASK_EVENTS.TASK_STARTED,
    taskId: task.id,
    taskKind: task.callerType ?? 'spawn_subagent',
    silent: false,
  });
  const taskStreamPath = `${taskResultDir}/${STREAM_FILE}`;
  const taskStreamWriter = createPerResourceStreamWriter(fs, taskStreamPath, auditWriter);
  taskStreamWriter.write({
    ts: Date.now(),
    type: STREAM_TASK_EVENTS.TASK_ATTEMPT_START,
    taskId: task.id,
  });

  try {
    // LLM is guaranteed by constructor (readonly non-null field)

    // Build per-task registry filtered by caller profile + motionClawDir 重建
    const isShadow = task.isShadow === true;
    const subagentProfile = callerTypeToProfile(task.callerType ?? 'spawn_subagent');
    const effectiveRegistry = (() => {
      const r = createPerTaskRegistry(registry, subagentProfile);

      // phase 713: motionClawDir 构造 motionDialogStore + AskMotionTool（全然一致性 reuse）
      if (task.motionClawDir) {
        const motionDialogStore = createDialogStore(
          fs,
          task.motionClawDir,
          new NoopAuditWriter(),  // ask_motion 不 own motion audit
          CURRENT_DIALOG_FILE,
        );
        const askMotion = deps.askMotionToolFactory(llm, motionDialogStore);
        r.register(askMotion);
      }

      // Phase 815/816: shadow 任务 apply restrictedOverrides
      // （sync 路径在 system.ts 做，async 路径统一调用 foundation 函数）
      if (isShadow) {
        applyRestrictedOverrides(r, registry);
      }

      return r;
    })();

    const toolsForLLM = registry.formatForLLM(effectiveRegistry.getAll());

    const finalSystemPrompt = buildSubagentSystemPrompt({
      taskId: task.id,
      callerClawId: task.parentClawId,
      subagentsDir: TASKS_SUBAGENTS_DIR,
      systemPrompt: task.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT,
    });

    // phase 1373 sub-5: task abort signal cascade to runSubagent
    const compositeSignal = AbortSignal.any?.([signal].filter(Boolean)) ?? signal;

    const { text, capturedResult } = await (deps.runSubagent ?? defaultRunSubagent)({
      agentId: task.id,
      toolProfile: callerTypeToProfile(task.callerType ?? 'spawn_subagent'),
      clawDir,
      fs,
      fsFactory,
      llm,
      registry: effectiveRegistry,
      prompt: task.mode === 'shadow' ? '' : task.intent,
      systemPrompt: task.shadowSystemPrompt ?? finalSystemPrompt,
      resultDir: taskResultDir,
      syncDir: nodePath.join(clawDir, TASKS_SYNC_DIR),
      maxSteps: task.maxSteps,
      signal: compositeSignal,
      toolsForLLM,
      timeoutMs: task.timeoutMs,
      toolTimeoutMs: deps.toolTimeoutMs,
      permissionChecker: deps.permissionChecker,
      messages: task.shadowMessages,
      isShadow,
      resultTool: isShadow ? DONE_TOOL_NAME : undefined,
    });

    const displayResult = getDisplayResult(text, capturedResult);
    const inboxResult = await applyPostProcessor(displayResult, task, false, postProcessors, fs, auditWriter);
    await sendResult(fs, auditWriter, task, inboxResult, false);

    emitTaskCompleted(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: deriveShortIdFromTaskId(task.id),
      status: 'ok',
      kind: 'subagent',
      parent: task.parentClawId,
      callerType: task.callerType ?? 'spawn_subagent',
      intent: auditWriter.preview(task.intent),  // phase 218: union 简化后两 mode 均有 intent
      elapsedMs: Date.now() - taskStartTime,
      len: displayResult.length,
      subAuditPath: `tasks/queues/results/${task.id}/audit.tsv`,
    });
  } catch (error) {
    taskFailed = true;
    const errorMsg = formatErr(error);

    const inboxResult = await applyPostProcessor(errorMsg, task, true, postProcessors, fs, auditWriter);

    // Send error result to parent inbox
    try {
      await sendResult(fs, auditWriter, task, inboxResult, true);
    } catch (sendErr) {
      // sendResult 本身失败：降级写最小通知，确保 parent 不被永远挂起
      try {
        await sendFallbackError(fs, auditWriter, task, errorMsg);
      } catch (fallbackErr) {
        emitResultDeliveryFailed(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: deriveShortIdFromTaskId(task.id),
          reason: 'both sendResult and sendFallbackError failed',
          error: formatErr(fallbackErr),
        });
        // task stays in failed/ for manual recovery (finally will move it)
      }
    }

    emitHandlerFailed(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: deriveShortIdFromTaskId(task.id),
      parent: task.parentClawId,
      error: errorMsg,
    });
    emitTaskCompleted(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: deriveShortIdFromTaskId(task.id),
      status: 'err',
      kind: 'subagent',
      parent: task.parentClawId,
      callerType: task.callerType ?? 'spawn_subagent',
      intent: auditWriter.preview(task.intent),  // phase 218: union 简化后两 mode 均有 intent
      errorCategory: classifyTaskError(error),
      elapsedMs: Date.now() - taskStartTime,
      subAuditPath: `tasks/queues/results/${task.id}/audit.tsv`,
    });
  } finally {
    // Move from running to done/failed based on success
    if (taskFailed) {
      await moveTaskToFailed(task.id);
    } else {
      await moveTaskToDone(task.id);
    }
  }
}
