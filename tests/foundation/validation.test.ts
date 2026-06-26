import { describe, it, expect, afterEach } from 'vitest';
import {
  VALID_PRIORITIES,
  validatePriority,
  validateType,
} from '../../src/foundation/messaging/codec-validation.js';

afterEach(() => {
  // no-op: kept in case future tests need cleanup
});

describe('VALID_PRIORITIES', () => {
  it('包含且仅包含四个优先级', () => {
    expect(VALID_PRIORITIES).toEqual(['critical', 'high', 'normal', 'low']);
  });
});

describe('validatePriority', () => {
  it('合法优先级原样返回', () => {
    expect(validatePriority('critical')).toBe('critical');
    expect(validatePriority('high')).toBe('high');
    expect(validatePriority('normal')).toBe('normal');
    expect(validatePriority('low')).toBe('low');
  });

  it('非法字符串降级为 normal', () => {
    expect(validatePriority('urgent')).toBe('normal');
    expect(validatePriority('CRITICAL')).toBe('normal');
    expect(validatePriority('')).toBe('normal');
  });

  it('非字符串输入降级为 normal', () => {
    expect(validatePriority(undefined)).toBe('normal');
    expect(validatePriority(null)).toBe('normal');
    expect(validatePriority(42)).toBe('normal');
    expect(validatePriority({})).toBe('normal');
  });
});

describe('validateType', () => {
  it('任意字符串类型原样返回（loose validation / M9 phase 575）', () => {
    expect(validateType('user_chat')).toBe('user_chat');
    expect(validateType('user_inbox_message')).toBe('user_inbox_message');
    expect(validateType('crash_notification')).toBe('crash_notification');
    expect(validateType('heartbeat')).toBe('heartbeat');
    expect(validateType('claw_outbox')).toBe('claw_outbox');
    expect(validateType('verification_result')).toBe('verification_result');
    expect(validateType('watchdog_ping')).toBe('watchdog_ping');
    expect(validateType('unknown_event')).toBe('unknown_event');
    expect(validateType('HEARTBEAT')).toBe('HEARTBEAT');
  });

  it('非字符串输入降级为 user_inbox_message (phase 9: message catch-all 移除)', () => {
    expect(validateType(undefined)).toBe('user_inbox_message');
    expect(validateType(null)).toBe('user_inbox_message');
    expect(validateType(42)).toBe('user_inbox_message');
    expect(validateType({})).toBe('user_inbox_message');
  });
});
