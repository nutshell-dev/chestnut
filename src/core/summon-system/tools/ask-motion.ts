import type { Tool } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import type { LLMOrchestrator } from '../../../foundation/llm-orchestrator/index.js';
import type { Message } from '../../../foundation/llm-provider/types.js';
import { buildAskMotionCloneFirstMessage } from '../../../prompts/index.js';
import { DialogStore } from '../../../foundation/dialog-store/index.js';

import { formatErr } from '../../../foundation/utils/format.js';
export const ASK_MOTION_TOOL_NAME = 'ask_motion' as const;

export const ASK_MOTION_TOOL_DESCRIPTION = `向 Motion 分身提问，获取 Motion 对用户意图、背景、偏好的判断。
分身继承 Motion 完整上下文（系统提示 + 当前对话历史），多轮问答自动累积。
适用场景：用户意图模糊、不确定目标 claw、需确认优先级或约束等。`;

export const ASK_MOTION_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: '向 Motion 分身提出的问题',
    },
  },
  required: ['question'],
};

export class AskMotionTool implements Tool {
  readonly name = ASK_MOTION_TOOL_NAME;
  readonly description = ASK_MOTION_TOOL_DESCRIPTION;
  readonly readonly = false;
  readonly idempotent = false;
  readonly profiles = ['miner'] as const;
  readonly group = 'subagent-protocol';

  readonly schema = ASK_MOTION_TOOL_SCHEMA;

  private readonly cloneHistory: Message[] = [];

  // phase 713: ctor 4 → 2 dep（llm + motionDialogStore）
  constructor(
    private readonly llm: LLMOrchestrator,
    private readonly motionDialogStore: DialogStore,
  ) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const question = args.question as string;
    const isFirstCall = this.cloneHistory.length === 0;
    const userContent = isFirstCall
      ? buildAskMotionCloneFirstMessage(question)
      : question;
    this.cloneHistory.push({ role: 'user', content: userContent });

    let answer: string;
    try {
      // phase 713: 全然一致性 reuse Motion DialogStore latest dialog snapshot
      // phase 1184: use loadStableTurnBoundary to avoid both mid-write race (phase 1102 loadStable)
      // and mid-turn 逻辑边界 race (unpaired tool_use → LLM API 400)
      const { session } = await this.motionDialogStore.loadStableTurnBoundary();

      const response = await this.llm.call({
        system: session.systemPrompt,                          // 全然一致性 / Motion 用啥 / 这里用啥
        messages: [...session.messages, ...this.cloneHistory],
        tools: session.toolsForLLM,                            // 全然一致性
      });

      const textBlocks = response.content.filter(b => b.type === 'text');
      const hasToolUse = response.content.some(b => b.type === 'tool_use');
      if (textBlocks.length === 0 || hasToolUse) {
        this.cloneHistory.pop();
        return { success: false, content: 'Motion 分身未返回文本回答，请重新提问。' };
      }
      const texts = textBlocks.map(b => (b as { type: 'text'; text?: string }).text ?? '');
      if (texts.every(t => t === '')) {
        this.cloneHistory.pop();
        return { success: false, content: 'Motion 分身未返回文本内容，请重新提问。' };
      }
      answer = texts.join('');
    } catch (err) {
      this.cloneHistory.pop();
      return {
        success: false,
        content: `Motion 分身调用失败：${formatErr(err)}`,
      };
    }

    this.cloneHistory.push({ role: 'assistant', content: answer });
    return { success: true, content: answer };
  }
}
