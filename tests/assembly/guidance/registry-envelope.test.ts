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
import { createMotionGuidanceRegistry, NO_GUIDANCE } from '../../../src/assembly/guidance/index.js';
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

  it('unknown type → null（last-win/unknown-null 行为不变）', () => {
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
});
