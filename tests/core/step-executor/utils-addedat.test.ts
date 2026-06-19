import { describe, it, expect } from 'vitest';
import { appendAssistantMessage, appendToolResults, toToolResultBlock } from '../../../src/core/step-executor/utils.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

describe('step-executor utils addedAt (phase 436)', () => {
  it('appendAssistantMessage fills addedAt', () => {
    const messages: Message[] = [];
    appendAssistantMessage(messages, [{ type: 'text', text: 'hi' }]);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('assistant');
    expect(typeof messages[0].addedAt).toBe('string');
    expect(messages[0].origin).toBeUndefined();
  });

  it('appendToolResults fills addedAt without origin', () => {
    const messages: Message[] = [];
    const result = toToolResultBlock('toolu_1', { success: true, content: 'ok' });
    appendToolResults(messages, [result]);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('user');
    expect(typeof messages[0].addedAt).toBe('string');
    expect(messages[0].origin).toBeUndefined();
  });
});
