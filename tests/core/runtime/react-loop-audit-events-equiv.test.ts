/**
 * phase 272 Step E: REACT_LOOP_AUDIT_EVENTS 机械等价 test
 *
 * Phase 375 裁决 2 主动设计「不抽共享层 / 手工 mirror」、注释明示「0 漂移」。
 * 历史 phase 63 + subagent 未同步实证：手工 mirror 机制无机械守约 → 漂。
 * 本 test 守约：runtime + subagent 两 const 必字面等价、NEW const 时同步 fail 强制 sync。
 */

import { describe, it, expect } from 'vitest';
import { REACT_LOOP_AUDIT_EVENTS as RUNTIME_RL } from '../../../src/core/runtime/runtime-audit-events.js';
import { REACT_LOOP_AUDIT_EVENTS as SUBAGENT_RL } from '../../../src/core/subagent/audit-events.js';

describe('REACT_LOOP_AUDIT_EVENTS 跨 file equivalence (phase 272 Step E)', () => {
  it('runtime + subagent keys 完全等价', () => {
    const runtimeKeys = Object.keys(RUNTIME_RL).sort();
    const subagentKeys = Object.keys(SUBAGENT_RL).sort();
    expect(subagentKeys).toEqual(runtimeKeys);
  });

  it('runtime + subagent values 完全等价 (per key)', () => {
    for (const key of Object.keys(RUNTIME_RL)) {
      expect((SUBAGENT_RL as Record<string, string>)[key]).toBe(
        (RUNTIME_RL as Record<string, string>)[key],
      );
    }
  });

  it('runtime + subagent same const reference (object structural equal)', () => {
    // 用 const object structural compare 全键值守
    expect(SUBAGENT_RL).toEqual(RUNTIME_RL);
  });
});
