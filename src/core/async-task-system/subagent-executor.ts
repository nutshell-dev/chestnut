import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { type StreamLog, STREAM_FILE, createPerResourceStreamWriter } from '../../foundation/stream/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';

import { applyRestrictedOverrides, type ToolRegistry } from '../../foundation/tools/index.js';
import { runSubagent as defaultRunSubagent, createPerTaskRegistry, getDisplayResult, TASKS_SUBAGENTS_DIR } from '../subagent/index.js';

import { STREAM_TASK_EVENTS } from './stream-events.js';
import { classifyTaskError } from './_helpers.js';
import {
  emitTaskCompleted,
  emitHandlerFailed,
  emitResultWriteFailed,
  emitResultDeliveryFailed,
  emitRecoveryFailed,
  emitTaskPostProcessorMissing,
} from './audit-emit.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import {
  TASKS_QUEUES_RESULTS_DIR,
  POST_PROCESS_INPUT_FILE,
} from './dirs.js';
import { TASKS_SYNC_DIR } from '../../foundation/claw-identity/index.js';
import { createProcessedResultStore } from './processed-result-store.js';
import * as nodePath from 'path';

import { buildSubagentSystemPrompt, DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../templates/prompts/index.js';
import { sendResult as defaultSendResult } from './result-delivery.js';
import type { SendResult, SendFallbackResult, WriteInboxAsync, ResultDeliveryDeps, ProcessedTaskResult } from './result-delivery-types.js';

import type { PostProcessor } from './post-processors/types.js';
import type { SubAgentTask, ToolTask, FullTaskId, ExecutorPayloadAdapter } from './types.js';
import { taskShortId } from './types.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import type { TaskId } from './types.js';

/** Compatibility for already-persisted tasks written before toolProfile existed.
 * Phase 1396 Step K: 'miner_subagent' branch is legacy v1 read-only; no new writer
 * should schedule miner callerType tasks.
 */
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
  /** phase 1863 (AT-D7)：executor payload 解释面（装配注入；owner 提供）。 */
  executorPayloadAdapter?: ExecutorPayloadAdapter;
  runSubagent?: typeof defaultRunSubagent;
  sendResult?: SendResult<SubAgentTask>;
  sendFallbackResult?: SendFallbackResult<SubAgentTask | ToolTask>;
  writeInboxAsync?: WriteInboxAsync;
}

/**
 * phase 1863 (AT-D14)：defer 来源可分辨——
 * `not_registered`=装配面缺失（initialize 后冻结 → 永久，terminal）；
 * `handler_deferred`=handler 内部 defer（有界重试）。
 */
export class PostProcessorDeferredError extends Error {
  constructor(message: string, readonly kind: 'not_registered' | 'handler_deferred') {
    super(message);
    this.name = 'PostProcessorDeferredError';
  }
}

/**
 * phase 1863 (AT-D14)：handler defer 累计上限（跨 live/recovery 的持久计数）。
 * Derivation: 3 = 与 MAX_RECOVERY_RETRIES 同型经验值（1 首跑 + 2 重试）；
 * 防 handler 永久 defer 使任务永留 running。
 */
export const MAX_POST_PROCESSOR_DEFERS = 3;

/** phase 1863 (AT-D14)：defer 计数持久化路径（result 目录内，跨重启累计）。 */
const POST_PROCESS_DEFER_COUNT_PATH = (taskId: TaskId) =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/post-process.defer-count`;

/**
 * phase 1863 (AT-D14)：记录一次 defer（读-增-写，result 目录内持久化）。
 * 异常不改变 defer 语义（任务仍留 running 重试）——均经 audit 显式：
 * 读取非 ENOENT 失败按 0 起算（宁延后触顶、不误杀）；计数损坏按已达上限
 * （mirror retry-counter corrupt→terminal，防损坏计数致无限 defer）。
 */
export async function recordProcessorDefer(
  fs: FileSystem,
  auditWriter: AuditLog,
  task: SubAgentTask,
): Promise<number> {
  let count = 0;
  try {
    const raw = await fs.read(POST_PROCESS_DEFER_COUNT_PATH(task.id));
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'defer_counter_corrupt',
        raw: auditWriter.preview(raw),
      });
      count = MAX_POST_PROCESSOR_DEFERS;
    } else {
      count = parsed;
    }
  } catch (err) {
    if (!isFileNotFound(err)) {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'defer_counter_read_failed',
        error: formatErr(err),
      });
    }
  }
  count += 1;
  try {
    await fs.writeAtomic(POST_PROCESS_DEFER_COUNT_PATH(task.id), String(count));
  } catch (err) {
    emitResultWriteFailed(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      context: 'defer_counter_write_failed',
      error: formatErr(err),
    });
  }
  return count;
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
    throw new PostProcessorDeferredError(`postProcessor "${task.postProcessor}" not registered`, 'not_registered');
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
    throw new PostProcessorDeferredError(formatErr(handlerErr), 'handler_deferred');
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

  try {
    // Phase 1 — execution: produce {content, sourceIsError}; execution failure
    // is recorded in audit here and becomes processor input, never delivered
    // directly and never reclassified by a later phase's failure.
    let source: { content: string; sourceIsError: boolean };
    let execErrorCategory: string | undefined;
    try {

    // Build per-task registry filtered by caller profile.
    // phase 1863 (AT-D7)：executor payload 语义归 owner——ATS 只把 opaque payload 交给装配注入
    // 的 adapter 解释（不含任何上层模式枚举/解释）。
    const interpretation = deps.executorPayloadAdapter?.(task.executorPayload);
    const subagentProfile = resolveTaskToolProfile(task, auditWriter);
    const effectiveRegistry = (() => {
      const r = createPerTaskRegistry(registry, subagentProfile);

      // Phase 815/816: 受限执行（如 shadow）经 owner 解释面声明 applyRestrictedOverrides
      if (interpretation?.applyRestrictedOverrides) {
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
      prompt: interpretation?.prompt ?? task.intent,
      systemPrompt: interpretation?.systemPrompt ?? finalSystemPrompt,
      resultDir: taskResultDir,
      syncDir: nodePath.join(clawDir, TASKS_SYNC_DIR),
      maxSteps: task.maxSteps,
      signal: compositeSignal,
      toolsForLLM,
      timeoutMs: task.timeoutMs,
      toolTimeoutMs: deps.toolTimeoutMs,
      permissionChecker: deps.permissionChecker,
      messages: interpretation?.messages,
      resultTool: interpretation?.resultTool,
    });

      const displayResult = getDisplayResult(text, capturedResult);
      source = { content: displayResult, sourceIsError: false };
    } catch (error) {
      const errorMsg = formatErr(error);
      execErrorCategory = classifyTaskError(error);
      // The original execution error is preserved in audit even when the
      // business outcome is later recovered by a post-processor.
      emitHandlerFailed(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        parent: task.parentClawId,
        error: errorMsg,
      });
      source = { content: errorMsg, sourceIsError: true };
    }

    // Phase 2 — persist durable post-process input. Failure leaves the task in
    // running; nothing has been committed yet, so recovery re-executes.
    try {
      await writePostProcessInput(fs, taskResultDir, source.content, source.sourceIsError);
    } catch (inputErr) {
      emitResultWriteFailed(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        context: 'post_process_input_persist',
        error: formatErr(inputErr),
      });
      return;
    }

    // Phase 3 — post-processor: decide the business outcome. Bounded-deferred keeps
    // the task in running with the durable input for startup recovery replay.
    let envelope: ProcessedTaskResult;
    try {
      envelope = await applyPostProcessor(source, task, postProcessors, fs, auditWriter);
    } catch (processorErr) {
      if (processorErr instanceof PostProcessorDeferredError) {
        // phase 1863 (AT-D14)：未注册=永久（装配面 initialize 后冻结）→ terminal failed，不再留 running。
        if (processorErr.kind === 'not_registered') {
          emitTaskPostProcessorMissing(auditWriter, {
            fullTaskId: task.id as FullTaskId,
            shortTaskId: taskShortId(task),
            processorName: task.postProcessor ?? '',
            reason: 'not_registered',
          });
          outcome = 'failed';
          return;
        }
        // handler 内部 defer：有界重试（累计 defer 次数达上限 → terminal failed）。
        const deferCount = await recordProcessorDefer(fs, auditWriter, task);
        if (deferCount >= MAX_POST_PROCESSOR_DEFERS) {
          emitTaskPostProcessorMissing(auditWriter, {
            fullTaskId: task.id as FullTaskId,
            shortTaskId: taskShortId(task),
            processorName: task.postProcessor ?? '',
            reason: 'defer_bounded',
          });
          outcome = 'failed';
          return;
        }
        auditWriter.write(
          TASK_AUDIT_EVENTS.POST_PROCESSOR_DEFERRED,
          `taskId=${task.id}`,
          `reason=${auditWriter.message(processorErr.message)}`,
          `deferCount=${deferCount}`,
        );
        return;
      }
      throw processorErr;
    }

    // Phase 4 — commit the final envelope (single atomic write; the only
    // business commit point). After this succeeds the processor is never
    // re-run for this task. The result.txt projection is non-authoritative:
    // its failure is audited but blocks neither delivery nor the terminal move.
    const resultStore = createProcessedResultStore(fs);
    try {
      await resultStore.commit(task.id, envelope);
    } catch (commitErr) {
      emitResultWriteFailed(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        context: 'envelope_commit_failed',
        error: formatErr(commitErr),
      });
      return; // leave in running; recovery replays the durable input
    }
    try {
      await resultStore.projectText(task.id, envelope);
    } catch (projectErr) {
      emitResultWriteFailed(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        context: 'result_text_projection_failed',
        error: formatErr(projectErr),
      });
    }

    // Phase 5 — deliver. A delivery failure only affects delivery status: the
    // committed envelope/content/isError stay untouched, the task stays in
    // running, and startup recovery resends the committed envelope.
    try {
      await sendResult(fs, auditWriter, task, envelope, resultDeliveryDeps);
    } catch (deliveryErr) {
      emitResultDeliveryFailed(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        reason: 'delivery_failed',
        error: formatErr(deliveryErr),
      });
      return;
    }

    outcome = envelope.isError ? 'failed' : 'done';

    // task_completed records the SOURCE execution outcome (status=ok|err) after
    // successful delivery — it is the post-inbox-write causal signal. The
    // processed terminal outcome (done/failed) is derived from envelope.isError.
    emitTaskCompleted(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      status: source.sourceIsError ? 'err' : 'ok',
      kind: 'subagent',
      parent: task.parentClawId,
      callerType: task.callerType ?? 'spawn_subagent',
      intent: auditWriter.preview(task.intent),  // phase 218: union 简化后两 mode 均有 intent
      ...(execErrorCategory !== undefined ? { errorCategory: execErrorCategory } : {}),
      elapsedMs: Date.now() - taskStartTime,
      len: source.content.length,
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
