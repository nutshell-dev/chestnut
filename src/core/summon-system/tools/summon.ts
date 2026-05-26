import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';

import type { Message, ToolDefinition } from '../../../foundation/llm-provider/types.js';
import { createSkillSystem } from '../../../foundation/skill-system/index.js';
import { DISPATCH_SKILLS_PATH as DISPATCH_SKILLS_DIR } from '../../evolution-system/index.js';

import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../../foundation/llm-orchestrator/index.js';
import { buildSummonContractTask, buildMinerSystemPrompt, buildMiningUserMessage } from '../../../prompts/index.js';
import { ASK_MOTION_TOOL_NAME, ASK_MOTION_TOOL_DESCRIPTION, ASK_MOTION_TOOL_SCHEMA } from './ask-motion.js';
import { writePendingSubagentTaskFile } from '../../async-task-system/index.js';
import { SUMMON_AUDIT_EVENTS } from '../audit-events.js';
import { spawnShadowSubagent } from '../../shadow-system/spawn-shadow-subagent.js';
import { stripIncompleteToolUse } from '../../shadow-system/_helpers.js';

const SUMMON_SUBAGENT_TIMEOUT_MS = 3600 * 1000;   // 1 hour

export const SUMMON_TOOL_NAME = 'summon' as const;

export class SummonTool implements Tool {
  readonly name = SUMMON_TOOL_NAME;
  readonly description = `召唤子代理，创建契约。支持两种模式（**按场景选**）：

**shadow（默认、推荐）**：子代理继承 Motion 完整上下文（对话历史 + 系统提示 + 完整工具集），无需问答即可继续推理 + 决策 + 执行。适用于 Motion 已与 user 充分对话、上下文足够的场景。

**mining（实验中、未完整实现）**：子代理空白起步，通过 ask_motion 工具与 Motion 多轮问答构建上下文，再完成任务。当前不建议使用。

两种模式均不能：
- 调用 spawn 工具（会报错）
- 递归调用 summon 工具

优先用 summon 的场景：
- 任务需要给 claw 创建契约
- 任务可能匹配已有 dispatch-skills

已知确切 prompt 的一次性任务、Motion 直接用 spawn 即可。`;

  readonly readonly = false;
  readonly idempotent = false;
  readonly profiles = ['full'] as const;

  constructor(
    private getSystemPrompt: () => Promise<string>,  // buildSystemPrompt() 是 async
    private getToolsForLLM: () => ToolDefinition[], // Motion 完整工具列表（KV cache 关键）
    private getToolsForProfile: (profile: string) => ToolDefinition[], // 按 profile 获取工具列表
    private getCurrentMessages?: () => Message[] | undefined,  // current turn dialogMessages (L4 → factory injection)
  ) {
    void this.getToolsForLLM;
    void this.getToolsForProfile;
  }

  schema = {
    type: 'object',
    properties: {
      goal:     { type: 'string', description: '本次目标：用户这次想完成什么（Motion 对用户意图的目标描述，不含 claw 名称）' },
      maxSteps: { type: 'number', description: '子代理最大步数（默认继承主循环 max_steps）' },
      idleTimeoutMs: {
        type: 'number',
        description: 'LLM 静默超时阈值（ms）。超过此时间无 LLM 输出则终止子代理。默认 60000ms。',
      },
      targetClaw: {
        type: 'string',
        description: '目标 claw id（kebab-case）。仅当用户明确指定了目标 claw 时填写，否则省略——claw 选择由子代理决定。若用户要求新建特定名称的 claw，请先创建再调用 summon。',
      },
      verify: {
        type: 'boolean',
        description: "是否要求契约带验证门控（默认 false）：true = subtask submit 后需走 verification（LLM 或 script）pass 才标 completed；false = subtask submit 即立即 completed（claw 调 submit_subtask 即完成对应子项）",
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
    if (ctx.isShadow) {
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
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        ctx.auditWriter?.write(SUMMON_AUDIT_EVENTS.LOAD_SKILLS_FAILED, `error=${String(e)}`);
      }
    }

    // 确定执行模式：shadow（默认、继承 Motion 上下文）或 mining（实验中、ask_motion 问答构建上下文）
    const mode = (args.mode as 'mining' | 'shadow') ?? 'shadow';
    const isMining = mode === 'mining';
    const callerType: 'shadow' | 'miner' = isMining ? 'miner' : 'shadow';
    const verify = args.verify === true;

    // 根据模式构建用户消息
    const userMessage = isMining
      ? buildMiningUserMessage(args.goal as string, skillsSummary, args.targetClaw as string | undefined, { verify })
      : buildSummonContractTask(args.goal as string, skillsSummary, args.targetClaw as string | undefined, { verify });
    if (isMining && !ctx.llm) {
      return { success: false, content: 'Mining mode requires LLM service, but none is available.' };
    }

    // 异步调度 summoner（后台运行，结果通过 inbox 送回）
    // miner 使用独立系统提示；shadow 复用 Motion 系统提示确保 KV cache 命中
    const systemPrompt = isMining
      ? buildMinerSystemPrompt()
      : await this.getSystemPrompt();
    const idleTimeoutMs = typeof args.idleTimeoutMs === 'number'
      ? args.idleTimeoutMs
      : DEFAULT_LLM_IDLE_TIMEOUT_MS;

    // 构造包含完整对话上下文的 messages 数组
    // L4 turn state → getter injection; canonical-only path (phase 1174)
    const dialogMessages = this.getCurrentMessages?.() ?? [];
    if (dialogMessages.length === 0) {
      ctx.auditWriter?.write(SUMMON_AUDIT_EVENTS.NO_DIALOG_CONTEXT);
    }

    // miner 使用专属工具列表（miner profile + ask_motion）；shadow 用 Motion 完整列表确保 KV cache 命中
    const motionClawDir = isMining ? ctx.clawDir : undefined;
    const toolsForLLM = isMining
      ? [
          ...this.getToolsForProfile('miner'),
          { name: ASK_MOTION_TOOL_NAME, description: ASK_MOTION_TOOL_DESCRIPTION, input_schema: ASK_MOTION_TOOL_SCHEMA },
        ]
      : this.getToolsForLLM();

    // 装配 mainContextSnapshot from ctx.currentToolUseId
    const mainContextSnapshot = ctx.clawId && ctx.currentToolUseId
      ? { clawId: ctx.clawId, toolUseId: ctx.currentToolUseId }
      : undefined;

    // 调度 summoner（声明式 postProcessor 替代 closure 注册）
    try {
      let taskId: string;
      if (!isMining) {
        const stripped = stripIncompleteToolUse(dialogMessages) ?? dialogMessages ?? [];
        const result = await spawnShadowSubagent({
          task: userMessage,
          mainMessages: stripped,
          ctx,
          systemPrompt: systemPrompt ?? '',
          toolsForLLM: toolsForLLM ?? [],
          timeoutMs: SUMMON_SUBAGENT_TIMEOUT_MS,
          idleTimeoutMs,
          postProcessor: 'summon-contract-extract',
          shadowIdPrefix: 'summon',
        });
        taskId = result.taskId;
      } else {
        taskId = await writePendingSubagentTaskFile(ctx.fs, ctx.auditWriter, {
          kind: 'subagent',
          mode: 'standard',
          intent: userMessage,
          timeoutMs: SUMMON_SUBAGENT_TIMEOUT_MS,
          maxSteps: (args.maxSteps as number) ?? ctx.subagentMaxSteps ?? ctx.maxSteps,
          parentClawId: ctx.clawId,
          originClawId: ctx.originClawId ?? ctx.clawId,
          callerType,                    // 'miner'
          motionClawDir,
          postProcessor: 'summon-contract-extract',  // 声明式 post-processor
          mainContextSnapshot,
          systemPrompt,                            // phase 546: 透传 caller-side specialized prompt（mining: buildMinerSystemPrompt）
        });
      }

      return {
        success: true,
        content: `Summon subagent started (${mode} mode). Task ID: ${taskId}. Result will arrive in inbox when complete.`,
        metadata: { taskId },
      };
    } catch (e) {
      throw e;
    }
  }
}
