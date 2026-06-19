import { describe, it, expect } from 'vitest';
import {
  SYSTEM_MESSAGE_PREFIX,
  isSystemMessage,
  isUserMessage,
} from '../../../src/foundation/messaging/system-message-helper.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

describe('SYSTEM_MESSAGE_PREFIX', () => {
  it('matches inbox-formatter output', () => {
    expect(SYSTEM_MESSAGE_PREFIX).toBe('[system message');
  });
});

describe('isSystemMessage', () => {
  it('returns true for user role + origin=system', () => {
    const msg: Message = {
      role: 'user',
      content: '[system message (1m ago)] heartbeat',
      origin: 'system',
      systemSubtype: 'heartbeat',
    };
    expect(isSystemMessage(msg)).toBe(true);
  });

  it('returns false for user role + origin=user', () => {
    const msg: Message = {
      role: 'user',
      content: 'hello',
      origin: 'user',
    };
    expect(isSystemMessage(msg)).toBe(false);
  });

  it('returns false for assistant role', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    };
    expect(isSystemMessage(msg)).toBe(false);
  });

  it('returns false for old dialog without origin field (backward compat)', () => {
    const msg: Message = {
      role: 'user',
      content: '[system message] heartbeat',
    };
    expect(isSystemMessage(msg)).toBe(false);
  });

  it('returns false for tool_result user message (origin not set)', () => {
    const msg: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
      addedAt: '2026-06-19T12:00:00Z',
    };
    expect(isSystemMessage(msg)).toBe(false);
  });
});

describe('isUserMessage', () => {
  it('returns true for user role + origin=user', () => {
    const msg: Message = { role: 'user', content: 'hi', origin: 'user' };
    expect(isUserMessage(msg)).toBe(true);
  });

  it('returns false for origin=system', () => {
    const msg: Message = { role: 'user', content: 'sys', origin: 'system' };
    expect(isUserMessage(msg)).toBe(false);
  });

  it('returns false for tool_result without origin', () => {
    const msg: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
    };
    expect(isUserMessage(msg)).toBe(false);
  });
});
