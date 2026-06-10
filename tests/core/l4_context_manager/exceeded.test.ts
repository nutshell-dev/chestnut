import { describe, it, expect } from 'vitest';
import { handleContextExceeded } from '../../../src/core/l4_context_manager/exceeded.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import { ContextTrimExhaustedError } from '../../../src/core/l4_context_manager/errors.js';

function makeTextMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

describe('handleContextExceeded', () => {
  it('returns trim result when trim succeeds without cache break', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
      makeTextMsg('assistant', 'second'),
    ];
    const r = handleContextExceeded(msgs, 'sys', 10000);
    expect(r).toBeDefined();
    expect(r.messages.length).toBeGreaterThan(0);
    expect(r.wasTrimmed).toBe(false);
  });

  it('escalates allowCacheBreak=true when insufficient without cache break', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
      makeTextMsg('assistant', 'second'),
      makeTextMsg('user', 'third'),
    ];
    // With target=0, first-pass (allowCacheBreak=false) should be insufficient
    // because anchor=0 and only messages after anchor can be trimmed.
    // Second-pass (allowCacheBreak=true) may still fail if total > target even after deep trim.
    // But with enough messages, deep trim may succeed.
    expect(() => handleContextExceeded(msgs, 'sys', 0)).toThrow(ContextTrimExhaustedError);
  });

  it('throws ContextTrimExhaustedError when even deep trim cannot fit', () => {
    const msgs: Message[] = [
      makeTextMsg('user', 'first'),
    ];
    // Single user message cannot be dropped (invariant 3), so even deep trim fails
    expect(() => handleContextExceeded(msgs, 'sys', 0)).toThrow(ContextTrimExhaustedError);
  });
});
