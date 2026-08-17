import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { type StreamLog, STREAM_FILE, createPerResourceStreamWriter } from '../../foundation/stream/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';

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
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import {
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,
  TASKS_SYNC_DIR,
  POST_PROCESS_INPUT_FILE,
  RESULT_META_FILE,
} from './dirs.js';
import * as nodePath from 'path';

import { buildSubagentSystemPrompt, DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../templates/prompts/index.js';
import { sendResult as defaultSendResult } from './result-delivery.js';
import type { SendResult, SendFallbackError, WriteInboxAsync, ResultDeliveryDeps, ProcessedTaskResult } from './result-delivery-types.js';

import type { Tool } from '../../foundation/tools/index.js';
import type { PostProcessor } from './post-processors/types.js';
import type { SubAgentTask, ToolTask, FullTaskId } from './types.js';
import { taskShortId } from './types.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import type { TaskId } from './types.js';

/** Compatibility for already-persisted tasks written before toolProfile existed. */
function legacyCallerTypeToProfile(ct: string) {
  if (ct === 'miner_subagent') return 'miner';
  if (ct === 'shadow_subagent') return 'full';
  return 'subagent';
}

function resolveTaskToolProfile(task: SubAgentTask, auditWriter: AuditLog): string {
  if (task.toolProfile) return task.toolProfile;
  const profile = legacyCallerTypeToProfile(task.callerType ?? 'spawn_subagent');
  auditWriter.write(
    TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
    'site=async-task-system/subagent-executor:resolveTaskToolProfile',
    'kind=legacy_task_missing_tool_profile',
    `taskId=${task.id}`,
    `derived_profile=${profile}`,
  );
  return profile;
}





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
  sendResult?: SendResult<SubAgentTask>;
  sendFallbackError?: SendFallbackError<SubAgentTask | ToolTask>;
  writeInboxAsync?: WriteInboxAsync;
}

class PostProcessorDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostProcessorDeferredError';
  }
}

function makeIdentityResult(content: string, isError: boolean): ProcessedTaskResult {
  return { schema_version: 1, content, isError };
}

export async function writePostProcessInput(
  fs: FileSystem,
  taskResultDir: string,
  content: string,
  sourceIsError: boolean,
): Promise<void> {
  const inputPath = `${taskResultDir}/${POST_PROCESS_INPUT_FILE}`;
  await fs.writeAtomic(inputPath, JSON.stringify({
    schema_version: 1,
    content,
    source_is_error: sourceIsError,
  }));
}

export async function commitFinalEnvelope(
  fs: FileSystem,
  taskResultDir: string,
  envelope: ProcessedTaskResult,
): Promise<void> {
  await fs.ensureDir(taskResultDir);
  const metaPath = `${taskResultDir}/${RESULT_META_FILE}`;
  const textPath = `${taskResultDir}/result.txt`;
  // Phase 1396 Step J: meta is the classification authority; write it first so
  // a crash between the two files never leaves a new text with an old/legacy
  // classification. Recovery treats (meta + text) as committed; missing text
  // with present meta falls back to replaying the durable input.
  await fs.writeAtomic(metaPath, JSON.stringify({
    schema_version: 1,
    is_error: envelope.isError,
    metadata: envelope.metadata,
  }));
  await fs.writeAtomic(textPath, envelope.content);
}

export async function applyPostProcessor(
  input: { content: string; sourceIsError: boolean },
  task: SubAgentTask,
  postProcessors: Map<string, PostProcessor>,
  fs: FileSystem,
  auditWriter: AuditLog,
): Promise<ProcessedTaskResult> {
  if (!task.postProcessor) return makeIdentityResult(input.content, input.sourceIsError);
  const handler = postProcessors.get(task.postProcessor);
  if (!handler) {
    emitHandlerFailed(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      context: 'postProcessor_not_found',
      name: task.postProcessor,
    });
    throw new PostProcessorDeferredError(`postProcessor "${task.postProcessor}" not registered`);
  }
  try {
    return await handler(input, task, fs, auditWriter);
  } catch (handlerErr) {
    if (handlerErr instanceof PostProcessorDeferredError) throw handlerErr;
    const ctx = input.sourceIsError ? 'postProcessor_threw_error_path' : 'postProcessor_threw';
    emitHandlerFailed(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      context: ctx,
      error: formatErr(handlerErr),
    });
    throw new PostProcessorDeferredError(formatErr(handlerErr));
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
  const sendResult = deps.sendResult ?? defaultSendResult;
  const taskStartTime = Date.now();
  const resultDeliveryDeps: ResultDeliveryDeps = { writeInboxAsync: deps.writeInboxAsync };

  // outcome: 'done'|'failed' = terminal move performed; undefined = leave in
  // running for recovery (delivery or processor deferral).
  let outcome: 'done' | 'failed' | undefined = undefined;

  // Per-task result dir + TASK_ATTEMPT_START stream marker（async 特有生命周期）
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

  async function finalizeEnvelope(content: string, sourceIsError: boolean): Promise<void> {
    await writePostProcessInput(fs, taskResultDir, content, sourceIsError);
    const envelope = await applyPostProcessor({ content, sourceIsError }, task, postProcessors, fs, auditWriter);
    await commitFinalEnvelope(fs, taskResultDir, envelope);
    await sendResult(fs, auditWriter, task, envelope, resultDeliveryDeps);
    outcome = envelope.isError ? 'failed' : 'done';
  }

  try {
    // LLM is guaranteed by constructor (readonly non-null field)

    // Build per-task registry filtered by caller profile + motionClawDir 重建
    const isShadow = task.isShadow === true;
    const subagentProfile = resolveTaskToolProfile(task, auditWriter);
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
      toolProfile: subagentProfile,
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
    await finalizeEnvelope(displayResult, false);

    emitTaskCompleted(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
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
    if (error instanceof PostProcessorDeferredError) {
      // Processor unavailable or threw: durable input is persisted; leave task
      // in running so startup recovery can replay after registry is ready.
      auditWriter.write(
        TASK_AUDIT_EVENTS.POST_PROCESSOR_DEFERRED,
        `taskId=${task.id}`,
        `reason=${auditWriter.message(error.message)}`,
      );
      return;
    }

    const errorMsg = formatErr(error);

    try {
      await finalizeEnvelope(errorMsg, true);
    } catch (finalizeErr) {
      if (finalizeErr instanceof PostProcessorDeferredError) {
        auditWriter.write(
          TASK_AUDIT_EVENTS.POST_PROCESSOR_DEFERRED,
          `taskId=${task.id}`,
          `reason=${auditWriter.message(finalizeErr.message)}`,
        );
        return;
      }
      // commit/send failed after the envelope was decided: leave in running;
      // recovery will resend the committed envelope or replay input.
      emitResultDeliveryFailed(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        reason: 'finalize_failed',
        error: formatErr(finalizeErr),
      });
      return;
    }

    emitHandlerFailed(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      parent: task.parentClawId,
      error: errorMsg,
    });
    emitTaskCompleted(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
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
    try {
      if (outcome === 'done') {
        await moveTaskToDone(task.id);
      } else if (outcome === 'failed') {
        await moveTaskToFailed(task.id);
      }
      // undefined => leave in running for recovery
    } finally {
      // Parent stream owns viewport watcher lifecycle. Emit on every terminal
      // path, including crashes before the per-task stream can write turn_end.
      parentStreamLog?.write({
        ts: Date.now(),
        type: STREAM_TASK_EVENTS.TASK_COMPLETED,
        taskId: task.id,
      });
    }
  }
}
