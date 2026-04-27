import type { Tool, ToolResult } from '../../tools/executor.js';
import type { LLMService } from '../../../foundation/llm/index.js';
import type { Message, ToolDefinition } from '../../../types/message.js';
import { buildAskMotionCloneFirstMessage } from '../../../prompts/index.js';

import { ASK_MOTION_TOOL_NAME } from '../../tools/tool-names.js';
export { ASK_MOTION_TOOL_NAME };

export class AskMotionTool implements Tool {
  readonly name = ASK_MOTION_TOOL_NAME;
  readonly description = `向 Motion 分身提问，获取 Motion 对用户意图、背景、偏好的判断。
分身继承 Motion 完整上下文（系统提示 + 当前对话历史），多轮问答自动累积。
适用场景：用户意图模糊、不确定目标 claw、需确认优先级或约束等。`;
  readonly readonly = false;
  readonly idempotent = false;

  readonly schema = {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '向 Motion 分身提出的问题',
      },
    },
    required: ['question'],
  };

  private readonly cloneHistory: Message[] = [];

  constructor(
    private readonly llm: LLMService,
    private readonly getSystemPrompt: () => Promise<string>,
    private readonly getToolsForLLM: () => ToolDefinition[],
    private readonly motionContext: Message[],  // dispatch 时快照，保持不变
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
      const [systemPrompt, tools] = await Promise.all([
        this.getSystemPrompt(),
        Promise.resolve(this.getToolsForLLM()),
      ]);

      const response = await this.llm.call({
        system: systemPrompt,
        messages: [...this.motionContext, ...this.cloneHistory],
        tools,
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
        content: `Motion 分身调用失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    this.cloneHistory.push({ role: 'assistant', content: answer });
    return { success: true, content: answer };
  }
}
