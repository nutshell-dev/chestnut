/**
 * claw-bar-display tests（phase 2003 Step E）
 *
 * formatClawBarError 是 viewport claw bar 与 launcher 错误行的共享格式化单源：
 * 错误类别、符号、前缀、摘要单行净化、inactive duration 规则逐字节锁定。
 */

import { describe, it, expect } from 'vitest';
import { formatClawBarError } from '../../src/cli-protocol/claw-bar-display.js';

describe('formatClawBarError', () => {
  it('daemon 两类：unreadable / stopped（形状与 buildClawLine 一致）', () => {
    expect(formatClawBarError('motion', { kind: 'daemon_unreadable' })).toBe('[motion] ✗ daemon unreadable');
    expect(formatClawBarError('motion', { kind: 'daemon_stopped' })).toBe('[motion] ✗ daemon stopped');
  });

  it('error：✗ + 单行净化摘要；inactiveMs 追加 duration 后缀', () => {
    expect(formatClawBarError('c', { kind: 'error', message: 'network timeout\nprovider down' }))
      .toBe('[c] ✗ network timeout provider down');
    expect(formatClawBarError('c', { kind: 'error', message: 'boom', inactiveMs: 3 * 60_000 }))
      .toBe('[c] ✗ boom · inactive 3m');
    expect(formatClawBarError('c', { kind: 'error', message: 'boom', inactiveMs: 65 * 60_000 }))
      .toBe('[c] ✗ boom · inactive 1h 5m');
  });

  it('interrupted：✗ interrupted + 可选 duration', () => {
    expect(formatClawBarError('c', { kind: 'interrupted' })).toBe('[c] ✗ interrupted');
    expect(formatClawBarError('c', { kind: 'interrupted', inactiveMs: 0 })).toBe('[c] ✗ interrupted · inactive 0m');
  });

  it('retry（⟳ 可恢复）与 blocked（⏸ 终局）不带 ✗', () => {
    expect(formatClawBarError('c', { kind: 'retry', message: 'context exceeded · retrying (1/3, 30s)' }))
      .toBe('[c] ⟳ context exceeded · retrying (1/3, 30s)');
    expect(formatClawBarError('c', { kind: 'blocked', message: 'context blocked (no_progress)' }))
      .toBe('[c] ⏸ context blocked (no_progress)');
  });

  it('输出不含 ANSI、不含换行（截断归调用方外壳）', () => {
    for (const state of [
      { kind: 'daemon_unreadable' },
      { kind: 'daemon_stopped' },
      { kind: 'error', message: 'a\nb\tc', inactiveMs: 1000 },
      { kind: 'interrupted', inactiveMs: 1000 },
      { kind: 'retry', message: 'x\ny' },
      { kind: 'blocked', message: 'x\ny' },
    ] as const) {
      const out = formatClawBarError('c', state);
      expect(out).not.toContain('\x1b');
      expect(out).not.toContain('\n');
    }
  });
});
