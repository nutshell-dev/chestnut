import { describe, it, expect } from 'vitest';
import { sanitizeForLLMCall } from '../../../src/foundation/llm-provider/sanitize.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

describe('sanitizeForLLMCall', () => {
  it('strips chestnut internal metadata fields', () => {
    const input: Message[] = [
      {
        role: 'user',
        content: 'hello',
        origin: 'user',
        addedAt: '2026-06-19T12:00:00Z',
      },
      {
        role: 'user',
        content: '[system message] heartbeat',
        origin: 'system',
        systemSubtype: 'heartbeat',
        addedAt: '2026-06-19T12:00:30Z',
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        addedAt: '2026-06-19T12:01:00Z',
      },
    ];

    const out = sanitizeForLLMCall(input);

    expect(out).toHaveLength(3);
    out.forEach(m => {
      expect(Object.keys(m).sort()).toEqual(['content', 'role']);
    });
  });

  it('preserves role and content (passthrough)', () => {
    const input: Message[] = [
      { role: 'user', content: 'hello', origin: 'user' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];

    const out = sanitizeForLLMCall(input);

    expect(out[0]).toEqual({ role: 'user', content: 'hello' });
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('returns new array (does not mutate caller ref)', () => {
    const input: Message[] = [{ role: 'user', content: 'hi', origin: 'user' }];
    const out = sanitizeForLLMCall(input);

    expect(out).not.toBe(input);
    expect(input[0].origin).toBe('user');
  });

  it('handles empty array', () => {
    expect(sanitizeForLLMCall([])).toEqual([]);
  });

  it('preserves trimmed field absence (does not add it)', () => {
    const input: Message[] = [
      {
        role: 'user',
        content: 'hi',
        trimmed: { trimmedAt: '2026-06-19', originalContentBytes: 200 },
      },
    ];
    const out = sanitizeForLLMCall(input);
    expect((out[0] as Message).trimmed).toBeUndefined();
  });
});
