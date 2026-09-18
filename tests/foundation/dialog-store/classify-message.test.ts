import { describe, it, expect } from 'vitest';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { classifyMessage } from '../../../src/foundation/dialog-store/index.js';

describe('classifyMessage (phase 1861, CM-D4 + CM-D10)', () => {
  it('user message with origin=user', () => {
    const m = { role: 'user', content: 'hi', origin: 'user' } as Message;
    expect(classifyMessage(m)).toEqual({ origin: 'user', systemSubtype: undefined });
  });

  it('system message exposes systemSubtype fact', () => {
    const m = {
      role: 'user',
      content: 'sys',
      origin: 'system',
      systemSubtype: 'heartbeat',
    } as Message;
    expect(classifyMessage(m)).toEqual({ origin: 'system', systemSubtype: 'heartbeat' });
  });

  it('system message without subtype → systemSubtype undefined', () => {
    const m = { role: 'user', content: 'sys', origin: 'system' } as Message;
    expect(classifyMessage(m).systemSubtype).toBeUndefined();
  });

  it('assistant message without business metadata', () => {
    const m = { role: 'assistant', content: 'ok' } as Message;
    expect(classifyMessage(m)).toEqual({ origin: undefined, systemSubtype: undefined });
  });

  it('view is a readonly projection (fact only, no message shape change)', () => {
    const m = { role: 'user', content: 'hi', origin: 'user' } as Message;
    const view = classifyMessage(m);
    expect(Object.keys(view).sort()).toEqual(['origin', 'systemSubtype']);
    expect(m).toEqual({ role: 'user', content: 'hi', origin: 'user' });
  });
});
