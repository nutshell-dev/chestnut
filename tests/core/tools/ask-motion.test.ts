import { describe, it, expect } from 'vitest';
import { AskMotionTool } from '../../../src/core/task/tools/ask-motion.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { Message } from '../../../src/types/message.js';

describe('AskMotionTool', () => {
  it('should not be readonly to prevent concurrent cloneHistory mutation', () => {
    const tool = new AskMotionTool(
      {} as LLMOrchestrator,
      async () => 'system prompt',
      () => [],
      [],
    );
    expect(tool.readonly).toBe(false);
  });

  it('consecutive executes produce strictly alternating user/assistant sequence', async () => {
    let callCount = 0;
    const llm = {
      call: async () => {
        callCount += 1;
        return {
          content: [{ type: 'text', text: `answer-${callCount}` }],
          stop_reason: 'end_turn',
        };
      },
    } as LLMOrchestrator;

    const tool = new AskMotionTool(
      llm,
      async () => 'system prompt',
      () => [],
      [],
    );

    await tool.execute({ question: 'q1' });
    await tool.execute({ question: 'q2' });

    const history = (tool as unknown as { cloneHistory: Message[] }).cloneHistory;
    const roles = history.map(m => m.role);

    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
