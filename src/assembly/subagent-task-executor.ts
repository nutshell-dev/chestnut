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
import type { LLMOrchestratorOwner } from '../foundation/llm-orchestrator/index.js';
import {
  LLMAllProvidersFailedError,
} from '../foundation/llm-orchestrator/index.js';
import { isAbortError } from '../foundation/llm-provider/index.js';
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
  /**
   * 执行业务装配（owner 注入；非 per-call infra）。
   * Phase 1933 Step E：类型升级为 LLMOrchestratorOwner；Phase 1934 Step C：
   * 共享故障的等待决定唯一归 owner（getSharedRecoveryDecision），本 adapter
   * 只消费结论（不再解释 snapshot/breaker）。runSubagent 只消费 LLMOrchestrator
   * 子集，接口兼容。
   */
  llm: LLMOrchestratorOwner;
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

/**
 * Phase 1933 Step E：等待事实 scope——进程内 orchestrator 实例的 opaque 标识
 * （ATS 不解析；故障状态本就不跨进程，scope 仅作证据关联）。
 */
const LLM_WAIT_SCOPE = 'claw-process' as const;

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
        // Phase 1933 Step E / 1934 Step C：共享 LLM 故障（全 provider 失败 = 进程内
        // 共享故障）→ 不返回失败，而是携带等待事实（core 持久化并把任务留 running）。
        // 等待决定唯一归 LLM owner：本 adapter 只消费 getSharedRecoveryDecision() 结论，
        // 不再解释 snapshot/breaker。owner 判 ready = 共享面无可等待故障（如纯
        // context_exceeded 聚合）→ 不携带 waiting，走既有失败路径。
        // abort/取消与超时不是共享故障（context_exceeded 归 caller trim 同理），
        // 走既有失败路径、不得携带 waiting。
        if (error instanceof LLMAllProvidersFailedError && !isAbortError(error)) {
          const nowMs = Date.now();
          const decision = deps.llm.getSharedRecoveryDecision();
          if (decision.kind === 'ready') {
            return { content: errorMsg, sourceIsError: true, errorCategory: classifyTaskError(error) };
          }
          // on_change（全候选等待配置变化）无时间下界：nextProbeAt 取 recordedAt
          // （仅证据字段；scheduleProbe 对 on_change 为 no-op，owner 不定时轮询）。
          const nextProbeAt = decision.kind === 'at' ? Math.max(nowMs, decision.nextProbeAt) : nowMs;
          return {
            content: errorMsg,
            sourceIsError: true,
            errorCategory: classifyTaskError(error),
            waiting: {
              scope: LLM_WAIT_SCOPE,
              nextProbeAt,
              recordedAt: nowMs,
              expiresAt: nowMs + task.timeoutMs,
              reason: errorMsg,
            },
          };
        }
        return { content: errorMsg, sourceIsError: true, errorCategory: classifyTaskError(error) };
      }
    },
  };
}
