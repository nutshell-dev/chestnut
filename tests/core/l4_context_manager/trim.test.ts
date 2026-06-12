import { describe, it, expect } from 'vitest';
import { trim } from '../../../src/core/l4_context_manager/trim.js';
import { estimateMessageTokens, estimateMessagesTokens } from '../../../src/foundation/llm-provider/token-estimator.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import { ContextTrimExhaustedError } from '../../../src/core/l4_context_manager/errors.js';

function makeTextMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function makeToolUseMsg(id: string, name: string, input: Record<string, unknown> = {}): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function makeToolResultMsg(tool_use_id: string, content: string): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] };
}

describe('trim algorithm (4 invariants)', () => {
  it('identity when total <= target', () => {
    const msgs: Message[] = [makeTextMsg('user', 'hi')];
    const r = trim(msgs, 'sys', { target: 10000 });
    expect(r.messages).toEqual(msgs);
    expect(r.droppedCount).toBe(0);
    expect(r.estimatedTokensAfter).toBe(estimateMessagesTokens(msgs));
  });

  it('drops from oldest when over target', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'hello world this is a longer message'),
      makeTextMsg('assistant', 'response one'),
      makeTextMsg('user', 'second user message'),
    ];
    const total = estimateMessagesTokens(msgs);
    // Target slightly below total so at least one message must be dropped
    const target = total - estimateMessageTokens(msgs[0]) - 1;
    const r = trim(msgs, 'sys', { target });
    expect(r.droppedCount).toBeGreaterThan(0);
    expect(r.estimatedTokensAfter).toBeLessThanOrEqual(target);
  });

  it('preserves first user message (invariant 3)', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
      makeTextMsg('assistant', 'second'),
      makeTextMsg('user', 'third'),
    ];
    const total = estimateMessagesTokens(msgs);
    // Set target low enough that trim must happen, but not so low it exhausts
    // Since first user must be preserved, target must be >= tokens of first user
    const target = estimateMessageTokens(msgs[0]);
    const r = trim(msgs, 'sys', { target });
    expect(r.messages.some(m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === 'first')).toBe(true);
  });

  it('tool_use and tool_result are paired (invariant 1)', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
      makeToolUseMsg('tu-1', 'read_file'),
      makeToolResultMsg('tu-1', 'file content'),
      makeTextMsg('assistant', 'done'),
    ];
    // Force trim by setting target low enough to require dropping the tool_use
    const target = estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[3]) - 1;
    const r = trim(msgs, 'sys', { target });
    // If tool_use (index 1) is dropped, tool_result (index 2) must also be dropped
    const hasToolUse = r.messages.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'));
    const hasToolResult = r.messages.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
    if (!hasToolUse) {
      expect(hasToolResult).toBe(false);
    }
  });

  it('throws ContextTrimExhaustedError when trim cannot fit target', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
      makeTextMsg('assistant', 'second'),
    ];
    // target=0 forces dropping everything possible; first user is protected and has tokens > 0.
    expect(() => trim(msgs, 'sys', { target: 0 })).toThrow(ContextTrimExhaustedError);
  });

  it('droppedCount reflects real number of dropped messages', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'hello'),
      makeTextMsg('assistant', 'world'),
      makeTextMsg('user', 'foo'),
    ];
    const total = estimateMessagesTokens(msgs);
    const target = estimateMessageTokens(msgs[0]);
    const r = trim(msgs, 'sys', { target });
    expect(r.messages.length + r.droppedCount).toBe(msgs.length);
    expect(r.estimatedTokensAfter).toBeLessThanOrEqual(target);
  });

  it('estimatedTokensAfter is real post-trim estimate', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'hello'),
      makeTextMsg('assistant', 'world'),
    ];
    const total = estimateMessagesTokens(msgs);
    const target = estimateMessageTokens(msgs[0]);
    const r = trim(msgs, 'sys', { target });
    const actualTokens = estimateMessagesTokens(r.messages);
    expect(r.estimatedTokensAfter).toBe(actualTokens);
  });
});
