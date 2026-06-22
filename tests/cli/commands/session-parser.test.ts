import { describe, it, expect } from 'vitest';
import { parseMessagesFromSession } from '../../../src/cli/commands/session-parser.js';
import type { Message, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock } from '../../../src/foundation/llm-provider/types.js';
import { makeToolUseId } from '../../../src/foundation/llm-provider/tool-use-id.js';

function text(text: string): TextBlock {
  return { type: 'text', text };
}

function thinking(thinkingText: string): ThinkingBlock {
  return { type: 'thinking', thinking: thinkingText };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: makeToolUseId(id), name, input };
}

function toolResult(toolUseId: string, content: string, is_error?: boolean): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: makeToolUseId(toolUseId), content, is_error };
}

function userMsg(content: string | Array<Exclude<Message['content'], string>>): Message {
  return { role: 'user', content: content as Message['content'] };
}

function assistantMsg(content: string | Array<Exclude<Message['content'], string>>): Message {
  return { role: 'assistant', content: content as Message['content'] };
}

describe('parseMessagesFromSession', () => {
  it('returns empty array for empty session', () => {
    expect(parseMessagesFromSession({ messages: [] })).toEqual([]);
  });

  it('parses assistant + user_tool_result into single Step', () => {
    const session = {
      messages: [
        assistantMsg([toolUse('tu_1', 'read', { path: '/x' })]),
        userMsg([toolResult('tu_1', 'OK')]),
      ],
    };
    const steps = parseMessagesFromSession(session);
    expect(steps).toHaveLength(1);
    expect(steps[0].num).toBe(1);
    expect(steps[0].toolUses).toHaveLength(1);
    expect(steps[0].toolUses[0].id).toBe(makeToolUseId('tu_1'));
    expect(steps[0].toolResults.get('tu_1')).toEqual(toolResult('tu_1', 'OK'));
  });

  it('attributes user text message to following assistant Step userInput', () => {
    const session = {
      messages: [
        userMsg([text('hello')]),
        assistantMsg([text('hi')]),
        userMsg([text('thanks')]),
      ],
    };
    const steps = parseMessagesFromSession(session);
    expect(steps).toHaveLength(1);
    expect(steps[0].userInput).toEqual({ content: 'hello', chars: 5 });
  });

  it('groups multiple assistant messages without intervening user into separate Steps', () => {
    const session = {
      messages: [
        assistantMsg([text('first')]),
        assistantMsg([text('second')]),
      ],
    };
    const steps = parseMessagesFromSession(session);
    expect(steps).toHaveLength(2);
    expect(steps[0].num).toBe(1);
    expect(steps[0].texts).toEqual(['first']);
    expect(steps[1].num).toBe(2);
    expect(steps[1].texts).toEqual(['second']);
  });

  it('captures thinking blocks separately', () => {
    const session = {
      messages: [
        assistantMsg([
          thinking('think text'),
          text('response'),
          toolUse('tu_1', 'read', { path: '/x' }),
        ]),
        userMsg([toolResult('tu_1', 'OK')]),
      ],
    };
    const steps = parseMessagesFromSession(session);
    expect(steps).toHaveLength(1);
    expect(steps[0].thinkings).toEqual(['think text']);
    expect(steps[0].texts).toEqual(['response']);
    expect(steps[0].toolUses).toHaveLength(1);
  });

  it('handles assistant-only messages (no following user) gracefully', () => {
    const session = {
      messages: [
        assistantMsg([text('standalone')]),
      ],
    };
    const steps = parseMessagesFromSession(session);
    expect(steps).toHaveLength(1);
    expect(steps[0].texts).toEqual(['standalone']);
    expect(steps[0].toolResults.size).toBe(0);
  });

  it('skips non-text user content (e.g. tool_result only) for userInput', () => {
    const session = {
      messages: [
        userMsg([toolResult('tu_1', 'OK')]),
        assistantMsg([text('got it')]),
      ],
    };
    const steps = parseMessagesFromSession(session);
    expect(steps).toHaveLength(1);
    expect(steps[0].userInput).toBeUndefined();
  });

  it('handles mixed user text and tool_result in same message', () => {
    const session = {
      messages: [
        userMsg([text('please do this'), toolResult('tu_1', 'result')]),
        assistantMsg([text('done')]),
      ],
    };
    const steps = parseMessagesFromSession(session);
    expect(steps).toHaveLength(1);
    expect(steps[0].userInput).toEqual({ content: 'please do this', chars: 14 });
  });
});
