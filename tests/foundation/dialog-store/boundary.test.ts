/**
 * Phase 1970 Step C: tool pair 结构安全插入点查询。
 */
import { describe, expect, it } from 'vitest';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { findToolPairSafeInsertionIndex } from '../../../src/foundation/dialog-store/index.js';

function assistantToolUse(id: string): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'exec', input: {} }] };
}

function userToolResult(id: string): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] };
}

function userText(text: string): Message {
  return { role: 'user', content: text, origin: 'user' };
}

describe('findToolPairSafeInsertionIndex', () => {
  it('pair 内候选点左移到 assistant 之前', () => {
    const messages = [assistantToolUse('t1'), userToolResult('t1')];
    expect(findToolPairSafeInsertionIndex(messages, 1)).toBe(0);
  });

  it('pair 之后候选点保持原位置', () => {
    const messages = [assistantToolUse('t1'), userToolResult('t1')];
    expect(findToolPairSafeInsertionIndex(messages, 2)).toBe(2);
  });

  it('无 tool pair 时候选点不变', () => {
    const messages = [userText('a'), { role: 'assistant' as const, content: 'b' }];
    expect(findToolPairSafeInsertionIndex(messages, 1)).toBe(1);
  });

  it('尾部未配对 tool_use 的开放 span 也左移（不追加伪 tool 响应）', () => {
    const messages = [assistantToolUse('t1')];
    expect(findToolPairSafeInsertionIndex(messages, 1)).toBe(0);
  });

  it('多个 tool_use 的结果分散在连续 user 消息中', () => {
    const messages = [
      { role: 'assistant' as const, content: [
        { type: 'tool_use' as const, id: 't1', name: 'exec', input: {} },
        { type: 'tool_use' as const, id: 't2', name: 'exec', input: {} },
      ] },
      userToolResult('t1'),
      userToolResult('t2'),
    ];
    expect(findToolPairSafeInsertionIndex(messages, 1)).toBe(0);
    expect(findToolPairSafeInsertionIndex(messages, 2)).toBe(0);
    expect(findToolPairSafeInsertionIndex(messages, 3)).toBe(3);
  });

  it('多 pair 时只受命中的 span 影响', () => {
    const messages = [
      assistantToolUse('t1'),
      userToolResult('t1'),
      assistantToolUse('t2'),
      userToolResult('t2'),
    ];
    expect(findToolPairSafeInsertionIndex(messages, 2)).toBe(2);
    expect(findToolPairSafeInsertionIndex(messages, 3)).toBe(2);
  });

  it('candidate 越界时 clamp 到 [0, length]', () => {
    const messages = [userText('a')];
    expect(findToolPairSafeInsertionIndex(messages, -5)).toBe(0);
    expect(findToolPairSafeInsertionIndex(messages, 99)).toBe(1);
  });

  it('无关 tool_result 不影响 span', () => {
    const messages = [userToolResult('other'), assistantToolUse('t1'), userToolResult('t1')];
    expect(findToolPairSafeInsertionIndex(messages, 2)).toBe(1);
    expect(findToolPairSafeInsertionIndex(messages, 1)).toBe(1);
  });
});
