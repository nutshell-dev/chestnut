/**
 * phase 1857 Step B (SE-D1): StepAbortReason 数据协议 + StepAbortError 载体 invariants
 *
 * 控制信号（idle_timeout / step_yield / user_interrupt）不再以三个独立 class 表达：
 * StepExecutor 只消费最小 abort reason 数据协议（判别联合），经单一载体抛出；
 * 上层按 reason.kind 数据判据消费。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  StepAbortError, isStepAbortError, throwAbortError,
} from '../../../src/core/step-executor/abort-helpers.js';

function abortWith(reason: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe('StepAbortError 载体', () => {
  it('is an Error（优于旧非 Error 信号对象，catch/格式化语义不变更差）', () => {
    expect(new StepAbortError({ kind: 'step_yield' }) instanceof Error).toBe(true);
  });

  it('name = "StepAbortError"，message 含 kind', () => {
    const err = new StepAbortError({ kind: 'idle_timeout', ms: 30000 });
    expect(err.name).toBe('StepAbortError');
    expect(err.message).toBe('step aborted: idle_timeout');
  });

  it('isStepAbortError 判别守卫收窄 reason', () => {
    expect(isStepAbortError(new StepAbortError({ kind: 'user_interrupt' }))).toBe(true);
    expect(isStepAbortError(new Error('x'))).toBe(false);
    expect(isStepAbortError({ reason: { kind: 'step_yield' } })).toBe(false);
    expect(isStepAbortError(undefined)).toBe(false);
  });
});

describe('throwAbortError — abort reason 数据协议矩阵', () => {
  it('idle_timeout 载荷 → StepAbortError { kind: idle_timeout, ms }', () => {
    try {
      throwAbortError(abortWith({ type: 'idle_timeout', ms: 30000 }));
      expect.unreachable();
    } catch (e) {
      expect(isStepAbortError(e)).toBe(true);
      if (isStepAbortError(e)) {
        expect(e.reason).toEqual({ kind: 'idle_timeout', ms: 30000 });
      }
    }
  });

  it('ms 缺失时 idle_timeout 兜底 0', () => {
    try {
      throwAbortError(abortWith({ type: 'idle_timeout' }));
      expect.unreachable();
    } catch (e) {
      expect(isStepAbortError(e)).toBe(true);
      if (isStepAbortError(e)) expect(e.reason).toEqual({ kind: 'idle_timeout', ms: 0 });
    }
  });

  it('step_yield 载荷 → StepAbortError { kind: step_yield }', () => {
    try {
      throwAbortError(abortWith({ type: 'step_yield' }));
      expect.unreachable();
    } catch (e) {
      expect(isStepAbortError(e)).toBe(true);
      if (isStepAbortError(e)) expect(e.reason).toEqual({ kind: 'step_yield' });
    }
  });

  it('user 载荷 → StepAbortError { kind: user_interrupt }', () => {
    try {
      throwAbortError(abortWith({ type: 'user' }));
      expect.unreachable();
    } catch (e) {
      expect(isStepAbortError(e)).toBe(true);
      if (isStepAbortError(e)) expect(e.reason).toEqual({ kind: 'user_interrupt' });
    }
  });

  it('未知载荷 → INVARIANT_VIOLATION 审计 + Error（非 StepAbortError）', () => {
    const write = vi.fn();
    try {
      throwAbortError(abortWith({ type: 'something_else' }), { write });
      expect.unreachable();
    } catch (e) {
      expect(isStepAbortError(e)).toBe(false);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain('[INVARIANT VIOLATION]');
    }
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('step_executor_invariant_violation');
  });

  it('无审计 writer 时未知载荷仍抛 invariant Error', () => {
    expect(() => throwAbortError(abortWith(null))).toThrow('[INVARIANT VIOLATION]');
  });
});
