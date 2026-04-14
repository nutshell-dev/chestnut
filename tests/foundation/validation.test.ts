import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  VALID_PRIORITIES,
  VALID_TYPES,
  validatePriority,
  validateType,
} from '../../src/core/communication/validation.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VALID_PRIORITIES', () => {
  it('包含且仅包含四个优先级', () => {
    expect(VALID_PRIORITIES).toEqual(['critical', 'high', 'normal', 'low']);
  });
});

describe('VALID_TYPES', () => {
  it('包含六种预定义消息类型', () => {
    expect(VALID_TYPES).toContain('message');
    expect(VALID_TYPES).toContain('user_chat');
    expect(VALID_TYPES).toContain('user_inbox_message');
    expect(VALID_TYPES).toContain('crash_notification');
    expect(VALID_TYPES).toContain('heartbeat');
    expect(VALID_TYPES).toContain('claw_outbox');
    expect(VALID_TYPES).toHaveLength(6);
  });
});

describe('validatePriority', () => {
  it('合法优先级原样返回', () => {
    expect(validatePriority('critical')).toBe('critical');
    expect(validatePriority('high')).toBe('high');
    expect(validatePriority('normal')).toBe('normal');
    expect(validatePriority('low')).toBe('low');
  });

  it('非法字符串降级为 normal 并 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(validatePriority('urgent')).toBe('normal');
    expect(validatePriority('CRITICAL')).toBe('normal');
    expect(validatePriority('')).toBe('normal');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('非字符串输入降级为 normal 并 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(validatePriority(undefined)).toBe('normal');
    expect(validatePriority(null)).toBe('normal');
    expect(validatePriority(42)).toBe('normal');
    expect(validatePriority({})).toBe('normal');
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe('validateType', () => {
  it('合法类型原样返回', () => {
    expect(validateType('message')).toBe('message');
    expect(validateType('user_chat')).toBe('user_chat');
    expect(validateType('user_inbox_message')).toBe('user_inbox_message');
    expect(validateType('crash_notification')).toBe('crash_notification');
    expect(validateType('heartbeat')).toBe('heartbeat');
    expect(validateType('claw_outbox')).toBe('claw_outbox');
  });

  it('watchdog_ 前缀类型原样透传，不触发 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(validateType('watchdog_ping')).toBe('watchdog_ping');
    expect(validateType('watchdog_')).toBe('watchdog_');
    expect(validateType('watchdog_complex_name')).toBe('watchdog_complex_name');
    expect(warn).not.toHaveBeenCalled();
  });

  it('未知字符串降级为 message 并 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(validateType('unknown_event')).toBe('message');
    expect(validateType('HEARTBEAT')).toBe('message');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('非字符串输入降级为 message，不触发 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(validateType(undefined)).toBe('message');
    expect(validateType(null)).toBe('message');
    expect(validateType(42)).toBe('message');
    expect(validateType({})).toBe('message');
    expect(warn).not.toHaveBeenCalled();
  });
});
