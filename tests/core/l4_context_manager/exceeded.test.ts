import { describe, it, expect } from 'vitest';
import { handleContextExceeded } from '../../../src/core/l4_context_manager/exceeded.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import { ContextTrimExhaustedError } from '../../../src/core/l4_context_manager/errors.js';

function makeTextMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

describe('handleContextExceeded', () => {
  it('returns trim result when trim succeeds', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
      makeTextMsg('assistant', 'second'),
    ];
    const r = handleContextExceeded(msgs, 'sys', 10000);
    expect(r).toBeDefined();
    expect(r.messages.length).toBeGreaterThan(0);
    expect(r.wasTrimmed).toBe(false);
  });

  it('throws ContextTrimExhaustedError when trim cannot fit', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
      makeTextMsg('assistant', 'second'),
      makeTextMsg('user', 'third'),
    ];
    // target=0 requires dropping below first user tokens, which is impossible.
    expect(() => handleContextExceeded(msgs, 'sys', 0)).toThrow(ContextTrimExhaustedError);
  });

  it('throws ContextTrimExhaustedError when even dropping all non-first-user messages cannot fit', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
    ];
    // Single user message cannot be dropped (invariant 3)
    expect(() => handleContextExceeded(msgs, 'sys', 0)).toThrow(ContextTrimExhaustedError);
  });
});
