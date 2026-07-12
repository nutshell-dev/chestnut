/**
 * Phase 918 Step B: regime-switch extractLastTurn behavior
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import { extractLastTurn } from '../../../src/foundation/dialog-store/regime-switch.js';

describe('extractLastTurn (phase 918)', () => {
  it('returns messages from the last genuine user input, skipping pure tool_result user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'genuine input' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'r' }] },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited[0].role).toBe('user');
    expect(inherited[0].content).toBe('genuine input');
    expect(inherited).toHaveLength(3);
  });

  it('skips multiple trailing pure tool_result user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'r1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'r2' }] },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited[0].content).toBe('first');
    expect(inherited).toHaveLength(5);
  });

  it('phase 919: skips user messages that mix tool_result with text', () => {
    const mixedContent: Message['content'] = [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'r' },
      { type: 'text', text: 'follow-up' },
    ];
    const messages: Message[] = [
      { role: 'user', content: 'genuine' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: {} }] },
      { role: 'user', content: mixedContent },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited[0].role).toBe('user');
    expect(inherited[0].content).toBe('genuine');
    expect(inherited).toHaveLength(3);
  });

  it('falls back to all messages when there is no genuine user input', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'hi' },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited).toEqual(messages);
  });

  it('returns all messages when the only user message is a plain string', () => {
    const messages: Message[] = [
      { role: 'user', content: 'plain' },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited).toEqual(messages);
  });
});
