import type { Tool, ToolResult, ExecContext } from '../../../foundation/tool-protocol/index.js';

import type { Message, ToolDefinition } from '../../../foundation/llm-provider/types.js';
import { createSkillSystem } from '../../../foundation/skill-system/index.js';
import { DISPATCH_SKILLS_PATH as DISPATCH_SKILLS_DIR } from '../../evolution-system/index.js';
import type { ToolRegistry } from '../../../foundation/tools/index.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../../foundation/llm-orchestrator/index.js';
import { buildDescribingUserMessage, buildMinerSystemPrompt, buildMiningUserMessage } from '../../../prompts/index.js';
import { ASK_MOTION_TOOL_NAME, ASK_MOTION_TOOL_DESCRIPTION, ASK_MOTION_TOOL_SCHEMA } from './ask-motion.js';
import { writePendingSubagentTaskFile } from './_pending-task-writer.js';
import { DISPATCH_AUDIT_EVENTS } from './dispatch-audit-events.js';

const DISPATCH_SUBAGENT_TIMEOUT_MS = 3600 * 1000;   // 1 hour

import { DISPATCH_TOOL_NAME } from '../../../foundation/tools/tool-names.js';
export { DISPATCH_TOOL_NAME };

export class DispatchTool implements Tool {
  readonly name = DISPATCH_TOOL_NAME;
  readonly description = `派发任务，创建契约。支持两种模式：

**mining（默认）**：创建意图挖掘子代理，通过与 Motion 分身多轮问答澄清用户意图，再由子代理完成契约创建。适合意图模糊或需确认优先级、目标 claw 的场景。

**describing**：直接创建子代理完成契约创建，子代理继承 Motion 的完整上下文。适合意图明确、无需额外澄清的场景。

两种模式均不能：
- 调用 spawn 工具（会报错）
- 递归调用 dispatch 工具

优先用 dispatch 的场景：
- 任务需要给 claw 创建契约
- 任务可能匹配已有 dispatch-skills

已知确切 prompt 的一次性任务，Motion 直接用 spawn 即可。`;

  readonly readonly = false;
  readonly idempotent = false;

  constructor(
    private getSystemPrompt: () => Promise<string>,  // buildSystemPrompt() 是 async
    private getToolsForLLM: () => ToolDefinition[], // Motion 完整工具列表（KV cache 关键）
    private getToolsForProfile: (profile: string) => ToolDefinition[], // 按 profile 获取工具列表
  ) {}

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
        description: '目标 claw id（kebab-case）。仅当用户明确指定了目标 claw 时填写，否则省略——claw 选择由子代理决定。若用户要求新建特定名称的 claw，请先创建再调用 dispatch。',
      },
      mode: {
        type: 'string',
        enum: ['describing', 'mining'],
        description: "调度模式。'mining'（默认）：先挖掘用户意图再创建契约；'describing'：直接进入契约创建流程。",
      },
    },
    required: ['goal'],
  };

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    // shadow 防御（phase 767）：dispatch 是 async-only routing，shadow 内调用会导致 orphan
    if (ctx.isShadow) {
      return {
        success: false,
        content: 'dispatch is not callable from within shadow (async-only routing would orphan after shadow exits).',
        error: 'shadow_dispatch_rejected',
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
        ctx.auditWriter?.write(DISPATCH_AUDIT_EVENTS.LOAD_SKILLS_FAILED, `error=${String(e)}`);
      }
    }

    // 确定调度模式：mining（默认，意图挖掘）或 describing（直接进入契约创建）
    const mode = (args.mode as 'mining' | 'describing') ?? 'mining';
    const isMining = mode === 'mining';
    const callerType: 'describer' | 'miner' = isMining ? 'miner' : 'describer';

    // 根据模式构建用户消息
    const userMessage = isMining
      ? buildMiningUserMessage(args.goal as string, skillsSummary, args.targetClaw as string | undefined)
      : buildDescribingUserMessage(args.goal as string, skillsSummary, args.targetClaw as string | undefined);
    if (isMining && !ctx.llm) {
      return { success: false, content: 'Mining mode requires LLM service, but none is available.' };
    }

    // 异步调度 dispatcher（后台运行，结果通过 inbox 送回）
    // miner 使用独立系统提示；describer 复用 Motion 系统提示确保 KV cache 命中
    const systemPrompt = isMining
      ? buildMinerSystemPrompt()
      : await this.getSystemPrompt();
    const idleTimeoutMs = typeof args.idleTimeoutMs === 'number'
      ? args.idleTimeoutMs
      : DEFAULT_LLM_IDLE_TIMEOUT_MS;

    // 构造包含完整对话上下文的 messages 数组
    const dialogMessages = ctx.dialogMessages ?? [];
    if (dialogMessages.length === 0) {
      ctx.auditWriter?.write(DISPATCH_AUDIT_EVENTS.NO_DIALOG_CONTEXT);
    }

    // messages 截止至当前 dispatch tool_use（loop 在执行工具前已追加），tool_result 尚未产生。
    // 历史 dispatch 对（tool_use + tool_result）保持完整，确保 KV cache 命中。
    const dispatcherMessages: Message[] = [...dialogMessages];

    // --- 关闭悬空的 dispatch tool_use ---
    //
    // dialogMessages 末尾是 assistant: tool_use(dispatch)，没有对应的 tool_result。
    // 原因：loop 在调用工具前已把 tool_use 追加到 messages，但 tool_result 在工具
    // 返回后才生成——而 dispatcher 作为异步任务，在工具返回之前就已拿到 messages 副本。
    //
    // 如果直接在 tool_use 后追加普通 user message（dispatcher 指令），会违反 Anthropic
    // API 规范（tool_use 后必须跟 tool_result），导致 LLM 行为不稳定：它会把"完成
    // dispatch 调用"误解为自己的任务，转而发通知报告而不是执行 dispatcher workflow。
    //
    // 修复：注入一个合并的 user message，同时包含：
    //   - tool_result：语法上关闭 dispatch tool_use（content 是占位符，dispatcher 无需知道
    //     Motion 实际收到的 "Dispatch subagent started..." 信息）
    //   - text：dispatcher 指令（与原 prompt 字段内容相同）
    // 两者合并为同一个 user message，保证消息结构 [tool_use → user(tool_result+text)] 合法。
    const lastMsg = dispatcherMessages[dispatcherMessages.length - 1];
    let dispatchToolUseId: string | undefined;
    if (lastMsg?.role === 'assistant' && Array.isArray(lastMsg.content)) {
      // 倒序遍历：多 tool_use blocks 并行调用时 dispatch 可能不是最后 block
      for (let i = lastMsg.content.length - 1; i >= 0; i--) {
        const block = lastMsg.content[i];
        if (block?.type === 'tool_use' && block.name === DISPATCH_TOOL_NAME) {
          dispatchToolUseId = (block as { type: string; id: string; name: string }).id;
          break;
        }
      }
    }
    if (dispatchToolUseId) {
      dispatcherMessages.push({
        role: 'user',
        content: [
          // 占位 tool_result：关闭 dispatch 调用，content 无需与 Motion 实际收到的相同
          { type: 'tool_result', tool_use_id: dispatchToolUseId, content: 'Dispatch subagent activated.' },
          // dispatcher 指令紧跟其后，同属一个 user turn
          { type: 'text', text: userMessage },
        ],
      });
    }

    // miner 使用专属工具列表（miner profile + ask_motion）；describer 用 Motion 完整列表确保 KV cache 命中
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

    // 调度 dispatcher（声明式 postProcessor 替代 closure 注册）
    try {
      const taskId = await writePendingSubagentTaskFile(ctx.fs, ctx.auditWriter, {
        kind: 'subagent',
        intent: userMessage,
        timeoutMs: DISPATCH_SUBAGENT_TIMEOUT_MS,
        maxSteps: (args.maxSteps as number) ?? ctx.subagentMaxSteps ?? ctx.maxSteps,
        parentClawId: ctx.clawId,
        originClawId: ctx.originClawId ?? ctx.clawId,
        callerType,                    // 'describer' 或 'miner'
        motionClawDir,
        postProcessor: 'dispatch-contract-extract',  // 声明式 post-processor
        mainContextSnapshot,
        systemPrompt,                            // phase 546: 透传 caller-side specialized prompt（mining: buildMinerSystemPrompt / describing: this.getSystemPrompt()）
      });

      return {
        success: true,
        content: `Dispatch subagent started (${mode} mode). Task ID: ${taskId}. Result will arrive in inbox when complete.`,
        metadata: { taskId },
      };
    } catch (e) {
      throw e;
    }
  }
}
