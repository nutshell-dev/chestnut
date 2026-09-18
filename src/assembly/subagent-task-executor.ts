/**
 * @module L6.Assembly.SubagentTaskExecutor
 * @layer L6 装配层
 *
 * phase 1863 (AT-D5)：SubAgent 执行的装配 adapter——AsyncTaskSystem 最小执行面
 * （TaskExecutor）的实现方。LLM / registry / runSubagent / executor payload 解释
 * 装配在此收口（M#1/M#2：执行装配归 owner 侧组合，通用调度核心不持业务装配）。
 */

import * as nodePath from 'path';
import { formatErr } from '../foundation/node-utils/index.js';
import { applyRestrictedOverrides } from '../foundation/tools/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { LLMOrchestrator } from '../foundation/llm-orchestrator/index.js';
import type { ToolRegistry } from '../foundation/tools/index.js';
import type { PermissionChecker } from '../foundation/tool-protocol/index.js';
import {
  runSubagent as defaultRunSubagent,
  createPerTaskRegistry,
  getDisplayResult,
  TASKS_SUBAGENTS_DIR,
} from '../core/subagent/index.js';
import { buildSubagentSystemPrompt, DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../templates/prompts/index.js';
import { TASKS_SYNC_DIR } from '../foundation/claw-identity/index.js';
import {
  TASKS_QUEUES_RESULTS_DIR,
  emitHandlerFailed,
  classifyTaskError,
  taskShortId,
  TASK_AUDIT_EVENTS,
} from '../core/async-task-system/index.js';
import type {
  SubAgentTask,
  TaskExecutor,
  TaskExecutionRuntime,
  TaskExecutionOutcome,
  ExecutorPayloadAdapter,
  FullTaskId,
} from '../core/async-task-system/index.js';

export interface SubagentTaskExecutorDeps {
  /** 执行业务装配（owner 注入；非 per-call infra）。 */
  llm: LLMOrchestrator;
  registry: ToolRegistry;
  toolTimeoutMs?: number;
  permissionChecker?: PermissionChecker;
  /** DI seam: optional runSubagent override (replaces vi.mock pattern) */
  runSubagent?: typeof defaultRunSubagent;
  /** phase 1863 (AT-D7)：executor payload 解释面（owner 提供，如 shadow）。 */
  executorPayloadAdapter?: ExecutorPayloadAdapter;
}

/**
 * phase 1863 (AT-D8)：profile 全由显式 toolProfile 决定（不再从 caller 身份派生）。
 * 缺失时按 standard subagent 默认 + INVARIANT_VIOLATION 留痕。
 */
function resolveTaskToolProfile(task: SubAgentTask, auditWriter: AuditLog): string {
  if (task.toolProfile) return task.toolProfile;
  auditWriter.write(
    TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
    'site=assembly/subagent-task-executor:resolveTaskToolProfile',
    'kind=legacy_task_missing_tool_profile',
    `taskId=${task.id}`,
    'derived_profile=subagent',
  );
  return 'subagent';
}

export function createSubagentTaskExecutor(deps: SubagentTaskExecutorDeps): TaskExecutor {
  return {
    async execute(task: SubAgentTask, signal: AbortSignal, runtime: TaskExecutionRuntime): Promise<TaskExecutionOutcome> {
      const { fs, fsFactory, auditWriter, clawDir } = runtime;
      try {
        // Build per-task registry filtered by caller profile.
        // phase 1863 (AT-D7)：executor payload 语义归 owner——本 adapter 只把 opaque payload
        // 交给注册的 adapter 解释（不含任何上层模式枚举/解释）。
        const interpretation = deps.executorPayloadAdapter?.(task.executorPayload);
        const subagentProfile = resolveTaskToolProfile(task, auditWriter);
        const effectiveRegistry = (() => {
          const r = createPerTaskRegistry(deps.registry, subagentProfile);

          // Phase 815/816: 受限执行（如 shadow）经 owner 解释面声明 applyRestrictedOverrides
          if (interpretation?.applyRestrictedOverrides) {
            applyRestrictedOverrides(r, deps.registry);
          }

          return r;
        })();

        const toolsForLLM = deps.registry.formatForLLM(effectiveRegistry.getAll());

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
          llm: deps.llm,
          registry: effectiveRegistry,
          prompt: interpretation?.prompt ?? task.intent,
          systemPrompt: interpretation?.systemPrompt ?? finalSystemPrompt,
          resultDir: `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`,
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

        return { content: getDisplayResult(text, capturedResult), sourceIsError: false };
      } catch (error) {
        const errorMsg = formatErr(error);
        // The original execution error is preserved in audit even when the
        // business outcome is later recovered by a post-processor.
        emitHandlerFailed(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          parent: task.parentClawId,
          error: errorMsg,
        });
        return { content: errorMsg, sourceIsError: true, errorCategory: classifyTaskError(error) };
      }
    },
  };
}
