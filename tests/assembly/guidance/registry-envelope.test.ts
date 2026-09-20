/**
 * phase 1256 Step B: MotionGuidanceRegistry envelope 保真单测。
 *
 * coverage test 只扫描注册字面，不足以证明 envelope 保真；本 file 断言：
 * - composer 收到**同一个** envelope 对象（identity），registry 不丢 `from`、不重建对象；
 * - unknown type 仍返 null；
 * - registered NO_GUIDANCE 仍显式返 null（sentinel 语义不变）。
 *
 * 反向（计划反向验收 #1/#4）：registry 若 `{ type, from, meta }` 重建或丢字段，
 * toBe identity / spy 断言即 fail。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createMotionGuidanceRegistry,
  GuidanceRegistryConflictError,
  NO_GUIDANCE,
} from '../../../src/assembly/guidance/index.js';
import type { GuidanceEnvelope } from '../../../src/core/runtime/index.js';

describe('phase 1256 Step B: registry compose envelope fidelity', () => {
  it('composer receives the exact same envelope object (type/from/meta identity)', () => {
    const registry = createMotionGuidanceRegistry();
    const spy = vi.fn().mockReturnValue({ text: 'G' });
    registry.register('claw_crashed', spy);

    const input: GuidanceEnvelope = {
      type: 'claw_crashed',
      from: 'claw-a',
      meta: { crash_class: 'active_unexpected', claw_id: 'clawA' },
    };
    const result = registry.compose(input);

    expect(result).toEqual({ text: 'G' });
    expect(spy).toHaveBeenCalledTimes(1);
    // identity：registry 原样转交、不重建/不丢 from
    expect(spy.mock.calls[0][0]).toBe(input);
    expect(spy.mock.calls[0][0].from).toBe('claw-a');
    expect(spy.mock.calls[0][0].meta).toBe(input.meta);
  });

  it('unknown type → null（未注册回退行为不变）', () => {
    const registry = createMotionGuidanceRegistry();
    expect(
      registry.compose({ type: 'never_registered', from: 'x', meta: {} }),
    ).toBeNull();
  });

  it('registered NO_GUIDANCE sentinel → 显式返 null', () => {
    const registry = createMotionGuidanceRegistry();
    registry.register('verification_result', NO_GUIDANCE);
    expect(
      registry.compose({ type: 'verification_result', from: 'worker-1', meta: { contract_id: 'c1' } }),
    ).toBeNull();
  });

  it('phase 1877 Step E: 重复 type 注册 fail-loud（含冲突 type、既有 composer 不被覆盖）', () => {
    const registry = createMotionGuidanceRegistry();
    const first = vi.fn().mockReturnValue({ text: 'first' });
    registry.register('dup_type', first);
    expect(registry.has('dup_type')).toBe(true);
    expect(registry.has('never_registered')).toBe(false);
    // Map.set last-win 静默覆盖路径已消除：typed/generic 同 namespace 门禁
    expect(() => registry.register('dup_type', NO_GUIDANCE))
      .toThrowError(GuidanceRegistryConflictError);
    expect(() => registry.register('dup_type', NO_GUIDANCE))
      .toThrowError(/dup_type/);
    // 既有 composer 保持、无部分覆盖
    expect(registry.compose({ type: 'dup_type', from: 'x', meta: {} })).toEqual({ text: 'first' });
    expect(first).toHaveBeenCalledTimes(1);
  });
});
