import { DISPATCH_SKILLS_PATH as DISPATCH_SKILLS_DIR } from '../dispatch-skills-paths.js';
import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';


import { createSkillSystem } from '../../../foundation/skill-system/index.js';

import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../../foundation/llm-orchestrator/index.js';
import { buildSummonContractTask, buildMinerSystemPrompt, buildMiningUserMessage } from '../../../prompts/index.js';


import { SUMMON_AUDIT_EVENTS, emitSummonDispatched, emitSummonRejectedShadow } from '../audit-events.js';
import { isFileNotFound } from '../../../foundation/fs/types.js';
import { SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME } from '../post-processors/contract-extract.js';
import { SUMMON_CALLER_TYPES, type SummonCallerType } from '../caller-types.js';
import { spawnShadowSubagent, stripIncompleteToolUse, SHADOW_CALLER_LABEL } from '../../shadow-system/index.js';
import { type TaskId, makeTaskId } from '../../async-task-system/types.js';

const SUMMON_SUBAGENT_TIMEOUT_MS = 3600 * 1000;   // 1 hour

export const SUMMON_TOOL_NAME = 'summon' as const;

export class SummonTool implements Tool {
  readonly name = SUMMON_TOOL_NAME;
  readonly description = `创建子代理来给 claw 创建契约。支持两种模式（**按场景选**）：

**shadow（默认、推荐）**：子代理继承 Motion 完整上下文（对话历史 + 系统提示 + 完整工具集），无需问答即可继续推理 + 决策 + 执行。适用于 Motion 已与 user 充分对话、上下文足够的场景。

**mining（实验中、未完整实现）**：子代理空白起步，通过 ask_motion 工具与 Motion 多轮问答构建上下文，再完成任务。当前不建议使用。

优先用 summon 的场景：
- 任务需要给 claw 创建契约
- 任务可能匹配已有 dispatch-skills
`;

  readonly readonly = false;
  readonly idempotent = false;
  readonly profiles = ['full'] as const;
  readonly group = 'spawn';
  /**
   * phase 1406: shadow mode reads caller's deep context (systemPrompt + tools +
   * messages) via ctx.getCallerSnapshot(). Mining mode does not need caller
   * snapshot (uses buildMinerSystemPrompt + ctx.registry for miner profile).
   *
   * Declared true to allow shadow's snapshot() call. ToolExecutor enforces.
   */
  readonly accessesCaller = true;

  // phase 281 Step B: SummonStateStore 已删；decision 内嵌 SubAgentTask metadata。
  constructor() {}

  schema = {
    type: 'object',
    properties: {
      goal:     { type: 'string', description: '本次目标：用户这次想完成什么（Motion 对用户意图的目标描述，不含 claw 名称）' },
      maxSteps: { type: 'number', description: '子代理最大步数（默认继承主循环 max_steps）' },
      idleTimeoutMs: {
        type: 'number',
        description: `LLM 静默超时阈值（ms）。超过此时间无 LLM 输出则终止子代理。默认 ${DEFAULT_LLM_IDLE_TIMEOUT_MS}ms。`,
      },
      targetClaw: {
        type: 'string',
        description: '目标 claw id（kebab-case）。仅当用户明确指定了目标 claw 时填写，否则省略——claw 选择由子代理决定。若用户要求新建特定名称的 claw，请先创建再调用 summon。',
      },
      verify: {
        type: 'boolean',
        description: "是否要求契约带验证门控（默认 false）：true = 契约子项提交后需走验收流程（LLM 或 script）pass 才标 completed；false = 契约子项提交后即立即 completed（claw 调 submit_subtask 即完成对应子项）",
      },
      mode: {
        type: 'string',
        enum: ['shadow', 'mining'],
        description: "执行模式（可选、默认 'shadow'）：'shadow' = 子代理继承 Motion 完整上下文（推荐）；'mining' = 子代理通过 ask_motion 多轮问答构建上下文（实验中、未完整实现、不建议使用）。",
      },
    },
    required: ['goal'],
  };

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    // shadow 防御（phase 767）：summon 是 async-only routing，shadow 内调用会导致 orphan
    if (ctx.callerLabel === SHADOW_CALLER_LABEL) {
      if (ctx.auditWriter && ctx.currentToolUseId) {
        emitSummonRejectedShadow(ctx.auditWriter, {
          toolUseId: ctx.currentToolUseId,
          reason: 'shadow_call_orphan_async_routing',
        });
      }
      return {
        success: false,
        content: 'summon is not callable from within shadow (async-only routing would orphan after shadow exits).',
        error: 'shadow_summon_rejected',
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

    // 模式 + 参数
    const mode = (args.mode as 'mining' | 'shadow') ?? 'shadow';
    const isMining = mode === 'mining';
    const verify = args.verify === true;
    const userMessage = isMining
      ? buildMiningUserMessage(args.goal as string, skillsSummary, args.targetClaw as string | undefined, { verify })
      : buildSummonContractTask(args.goal as string, skillsSummary, args.targetClaw as string | undefined, { verify });
    const idleTimeoutMs = typeof args.idleTimeoutMs === 'number' ? args.idleTimeoutMs : DEFAULT_LLM_IDLE_TIMEOUT_MS;
    const mainContextSnapshot = ctx.clawId && ctx.currentToolUseId
      ? { clawId: ctx.clawId, toolUseId: ctx.currentToolUseId }
      : undefined;

    if (isMining && !ctx.llm) {
      return { success: false, content: 'Mining mode requires LLM service, but none is available.' };
    }

    // dispatch
    try {
      const result = isMining
        ? await this.executeMining({
            userMessage,
            idleTimeoutMs,
            ctx,
            mainContextSnapshot,
            callerType: SUMMON_CALLER_TYPES.MINER,
            motionClawDir: ctx.clawDir,
            maxSteps: args.maxSteps as number | undefined,
            verify,
            targetClaw: args.targetClaw as string | undefined,
          })
        : await this.executeShadow({
            userMessage,
            idleTimeoutMs,
            ctx,
            mainContextSnapshot,
            verify,
            targetClaw: args.targetClaw as string | undefined,
          });

      if (!('taskId' in result)) return result;

      // audit + success return
      if (ctx.auditWriter && ctx.currentToolUseId) {
        emitSummonDispatched(ctx.auditWriter, {
          toolUseId: ctx.currentToolUseId,
          taskId: result.taskId,
          mode,
          targetClaw: args.targetClaw as string | undefined,
          verify,
        });
      }

      return {
        success: true,
        content: `Summon subagent dispatched (${mode} mode) to create contract. Task ID: ${result.taskId}. You'll get an inbox notification once the contract is created.`,
        metadata: { taskId: result.taskId },
      };
    } catch (e) {
      throw e;
    }
  }

  private async executeShadow(opts: {
    userMessage: string;
    idleTimeoutMs: number;
    ctx: ExecContext;
    mainContextSnapshot: { clawId: string; toolUseId: string } | undefined;
    verify: boolean;
    targetClaw?: string;
  }): Promise<{ taskId: TaskId } | { success: false; content: string; error?: string }> {
    const { userMessage, idleTimeoutMs, ctx, verify, targetClaw } = opts;
    if (!ctx.getCallerSnapshot) {
      return {
        success: false,
        content: 'summon shadow mode requires caller snapshot (ExecContext.getCallerSnapshot not bound by Assembly).',
        error: 'summon_caller_snapshot_unavailable',
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
      systemPrompt: snap.systemPrompt ?? '',
      toolsForLLM: snap.tools ?? [],
      timeoutMs: SUMMON_SUBAGENT_TIMEOUT_MS,
      idleTimeoutMs,
      postProcessor: SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
      shadowIdPrefix: 'summon',
      summonDecision: {
        schema_version: 1,
        mode: 'shadow',
        verify,
        targetClaw,
        dispatchedAt: new Date().toISOString(),
      },
    });
    if (!('taskId' in result)) return result;

    return { taskId: result.taskId };
  }

  private async executeMining(opts: {
    userMessage: string;
    idleTimeoutMs: number;
    ctx: ExecContext;
    mainContextSnapshot: { clawId: string; toolUseId: string } | undefined;
    callerType: SummonCallerType;
    motionClawDir: string | undefined;
    maxSteps: number | undefined;
    verify: boolean;
    targetClaw?: string;
  }): Promise<{ taskId: TaskId } | { success: false; content: string }> {
    const { userMessage, ctx, mainContextSnapshot, callerType, motionClawDir, maxSteps, verify, targetClaw } = opts;
    const systemPrompt = buildMinerSystemPrompt();
    // toolsForLLM is built for LLM-side miner profile; current schedule signature
    // doesn't pass tools (mining branch reads ctx.registry on subagent boot per phase 1406).
    // Kept as documentation of intent; if AsyncTask schedule grows tools param later, plumb through.

    if (!ctx.taskSystem) {
      return {
        success: false,
        content: '[summon mining] task_system not available in execution context — async path requires AsyncTaskSystem injection',
      };
    }

    const taskId = makeTaskId(await ctx.taskSystem.schedule('subagent', {
      kind: 'subagent',
      mode: 'standard',
      intent: userMessage,
      timeoutMs: SUMMON_SUBAGENT_TIMEOUT_MS,
      maxSteps: maxSteps ?? ctx.subagentMaxSteps ?? ctx.maxSteps,
      parentClawId: ctx.clawId,
      originClawId: ctx.originClawId ?? ctx.clawId,
      callerType,
      motionClawDir,
      postProcessor: SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
      mainContextSnapshot,
      systemPrompt,
      summonDecision: {
        schema_version: 1,
        mode: 'mining',
        verify,
        targetClaw,
        dispatchedAt: new Date().toISOString(),
      },
    }));

    return { taskId };
  }
}
