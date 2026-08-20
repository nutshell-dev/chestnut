import { DISPATCH_SKILLS_PATH as DISPATCH_SKILLS_DIR } from '../../evolution-system/index.js';
import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';


import { createSkillSystem } from '../../../foundation/skill-system/index.js';

import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../../foundation/llm-orchestrator/index.js';
import { buildSummonContractTask } from '../../../templates/prompts/index.js';


import { SUMMON_AUDIT_EVENTS, emitSummonDispatched, emitSummonRejectedShadow } from '../audit-events.js';
import { isFileNotFound } from '../../../foundation/fs/index.js';
import { SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME } from '../post-processors/contract-extract.js';
import { spawnShadowSubagent, stripIncompleteToolUse } from '../../shadow-system/index.js';
import { type SubAgentTaskScheduler, type TaskId } from '../../async-task-system/index.js';

/**
 * Summon subagent execution timeout（ms）= 1 hour.
 * Derivation: 3600 * 1000 = 1hr / 给子代理足够时长完成「契约创建」（含多轮 LLM call + 工具执行）/
 * 比 SUBAGENT_TIMEOUT_MS (5min) 长 12× 因 summon 全流程复杂 / 上限防 hung subagent.
 */
const SUMMON_SUBAGENT_TIMEOUT_MS = 3600 * 1000;

export const SUMMON_TOOL_NAME = 'summon' as const;

/**
 * Phase 1396 Step C: summon 公开契约收缩为普通异步工具调用 ——
 * agent-facing 入参只有 `goal`；内部固定 shadow 执行路径（实现细节不外露）；
 * maxSteps / idle timeout / verify 取系统内部默认，不读 agent args。
 * 成功只表示 contract 创建完成；立即返回只表示 async accepted。
 */
export class SummonTool implements Tool {
  private readonly taskSystem?: SubAgentTaskScheduler;
  private readonly originClawId?: string;
  private readonly allowFromShadow?: boolean;

  readonly name = SUMMON_TOOL_NAME;
  readonly description = `异步创建契约（contract）来完成用户目标。

这是一个异步工具：调用立即返回仅表示任务已被系统可靠接受（不代表契约已创建）。契约创建完成后，最终结果会异步送达：成功时告知契约已创建及 contractId，失败时告知失败原因。

适用场景：
- 任务需要通过创建契约来完成
`;

  readonly readonly = false;
  readonly idempotent = false;
  readonly profiles = ['full'] as const;
  readonly group = 'spawn';
  /**
   * phase 1406: shadow mode reads caller's deep context (systemPrompt + tools +
   * messages) via ctx.getCallerSnapshot().
   *
   * Declared true to allow shadow's snapshot() call. ToolExecutor enforces.
   */
  readonly accessesCaller = true;
  readonly restrictedOverrides = { allowFromShadow: false };

  // phase 281 Step B: SummonStateStore 已删；decision 内嵌 SubAgentTask metadata。
  // Phase 1396 Step K: 移除无行为的 _subagentMaxSteps 占位，避免位置参数误传。
  constructor(
    taskSystem?: SubAgentTaskScheduler,
    originClawId?: string,
    allowFromShadow: boolean = true,
  ) {
    this.taskSystem = taskSystem;
    this.originClawId = originClawId;
    this.allowFromShadow = allowFromShadow;
  }

  schema = {
    type: 'object',
    properties: {
      goal: { type: 'string', minLength: 1, description: '本次目标：用户这次想完成什么（对用户意图的目标描述）' },
    },
    required: ['goal'],
    additionalProperties: false,
  };

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    // shadow 防御（phase 767）：summon 是 async-only routing，shadow 内调用会导致 orphan；DI 注入替代 ctx.callerLabel
    if (this.allowFromShadow === false) {
      if (ctx.auditWriter && ctx.currentToolUseId) {
        emitSummonRejectedShadow(ctx.auditWriter, {
          toolUseId: ctx.currentToolUseId,
          reason: 'shadow_call_orphan_async_routing',
        });
      }
      return {
        success: false,
        content: 'Summon is unavailable in the current execution context.',
        error: 'summon_unavailable',
      };
    }

    // 扫描 clawspace/dispatch-skills/ 生成简介（结构同普通 skill：子目录 + SKILL.md）
    let skillsSummary = '';
    try {
      const dispatchSkillRegistry = createSkillSystem(ctx.fs, DISPATCH_SKILLS_DIR, ctx.auditWriter);
      await dispatchSkillRegistry.loadAll();
      const formatted = dispatchSkillRegistry.formatForContext();
      if (!formatted.includes('No skills loaded')) {
        skillsSummary = formatted;
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!isFileNotFound(e) && code !== 'ENOTDIR') {
        ctx.auditWriter?.write(SUMMON_AUDIT_EVENTS.LOAD_SKILLS_FAILED, `error=${String(e)}`);
      }
    }

    // Phase 1396 Step C/K: 内部固定 shadow 路径 + no-verification 策略由 policy
    // 直接拥有；agent 只提供 goal。
    const userMessage = buildSummonContractTask(args.goal as string, skillsSummary);
    const mainContextSnapshot = ctx.clawId && ctx.currentToolUseId
      ? { clawId: ctx.clawId, toolUseId: ctx.currentToolUseId }
      : undefined;

    const result = await this.executeShadow({
      userMessage,
      idleTimeoutMs: DEFAULT_LLM_IDLE_TIMEOUT_MS,
      ctx,
      mainContextSnapshot,
    }, this.taskSystem);
    if (!('taskId' in result)) return result;

    // audit + accepted return（只表示 async accepted，不宣称创建成功）
    if (ctx.auditWriter && ctx.currentToolUseId) {
      emitSummonDispatched(ctx.auditWriter, {
        toolUseId: ctx.currentToolUseId,
        taskId: result.taskId,
      });
    }

    return {
      success: true,
      content: `Summon accepted. Task ID: ${result.taskId}. Contract creation runs asynchronously; the final result will be delivered when creation finishes.`,
      metadata: { taskId: result.taskId },
    };
  }

  private async executeShadow(
    opts: {
      userMessage: string;
      idleTimeoutMs: number;
      ctx: ExecContext;
      mainContextSnapshot: { clawId: string; toolUseId: string } | undefined;
    },
    taskSystem?: SubAgentTaskScheduler,
  ): Promise<{ taskId: TaskId } | { success: false; content: string; error?: string }> {
    const { userMessage, idleTimeoutMs, ctx } = opts;
    if (!ctx.getCallerSnapshot) {
      ctx.auditWriter?.write(SUMMON_AUDIT_EVENTS.REJECTED_SHADOW, 'reason=caller_snapshot_unavailable');
      return {
        success: false,
        content: 'Summon is unavailable in the current execution context.',
        error: 'summon_unavailable',
      };
    }
    const snap = await ctx.getCallerSnapshot();
    if (snap.messages.length === 0) {
      ctx.auditWriter?.write(SUMMON_AUDIT_EVENTS.NO_DIALOG_CONTEXT);
    }
    const stripped = stripIncompleteToolUse(snap.messages) ?? snap.messages ?? [];
    const result = await spawnShadowSubagent({
      task: userMessage,
      mainMessages: stripped,
      ctx,
      taskSystem,
      originClawId: this.originClawId ?? ctx.clawId,
      systemPrompt: snap.systemPrompt ?? '',
      toolsForLLM: snap.tools ?? [],
      timeoutMs: SUMMON_SUBAGENT_TIMEOUT_MS,
      idleTimeoutMs,
      postProcessor: SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
      shadowIdPrefix: 'summon',
      // Phase 1402 Step B: active writer 停写 summon 专属 decision metadata；task identity
      // 由 canonical postProcessor 承担，时间事实已有 task.createdAt；v1/v2 仅 legacy read-only 恢复输入。
    });
    if (!('taskId' in result)) return result;

    return { taskId: result.taskId };
  }
}
