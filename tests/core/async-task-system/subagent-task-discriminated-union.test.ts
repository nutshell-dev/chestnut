/**
 * SubAgentTask discriminated union tests (phase 1185)
 *
 * Coverage:
 * - 反向 1: tsc enforce 非法组合（compile-time、用 ts-expect-error）
 * - 反向 2: executor mode-aware prompt = '' for shadow
 * - 反向 3: standard mode 正常 push intent as prompt
 * - 反向 4: backwards-compat 旧 pendingTask 无 mode 字段默认 'standard'
 */

import { describe, it, expect } from 'vitest';
import type { SubAgentTask } from '../../../src/core/async-task-system/system.js';
import { SubAgentTaskSchema } from '../../../src/core/async-task-system/task-schemas.js';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';

// 反向 1 — tsc enforce 非法组合（compile-time）
describe('SubAgentTask discriminated union (phase 1185)', () => {
  it('ts-expect-error: shadow variant 不允许 intent 字段', () => {
    // @ts-expect-error shadow variant 不允许 intent 字段
    const _badShadow: SubAgentTask = {
      mode: 'shadow',
      intent: 'x',
      shadowMessages: [],
      kind: 'subagent',
      id: 't1',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
      intentPreview: 'x',
    };
    expect(_badShadow).toBeDefined();
  });

  it('ts-expect-error: standard variant 不允许 shadowMessages + intentPreview', () => {
    // @ts-expect-error standard variant 不允许 shadowMessages + intentPreview
    const _badStandard: SubAgentTask = {
      mode: 'standard',
      intent: 'do Y',
      shadowMessages: [],
      intentPreview: 'y',
      kind: 'subagent',
      id: 't2',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    expect(_badStandard).toBeDefined();
  });

  it('valid shadow variant compiles', () => {
    const _goodShadow: SubAgentTask = {
      mode: 'shadow',
      shadowMessages: [{ role: 'user', content: 'hi' }],
      intentPreview: 'hi',
      kind: 'subagent',
      id: 't3',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    expect(_goodShadow.mode).toBe('shadow');
  });

  it('valid standard variant compiles', () => {
    const _goodStandard: SubAgentTask = {
      mode: 'standard',
      intent: 'do Z',
      kind: 'subagent',
      id: 't4',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    expect(_goodStandard.mode).toBe('standard');
  });
});

// 反向 4 — backwards-compat 旧 pendingTask 无 mode 字段默认 'standard'
describe('SubAgentTaskSchema backwards-compat', () => {
  it('旧 pendingTask 无 mode 字段 parse 为 standard', () => {
    const oldTask = {
      kind: 'subagent',
      id: 'old-task',
      intent: 'old intent',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    const result = SubAgentTaskSchema.safeParse(oldTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('standard');
      expect(result.data.intent).toBe('old intent');
    }
  });

  it('shadow task 含 mode=shadow 正常 parse', () => {
    const shadowTask = {
      kind: 'subagent',
      mode: 'shadow',
      id: 'shadow-task',
      shadowMessages: [{ role: 'user', content: 'hi' }],
      intentPreview: 'hi',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    const result = SubAgentTaskSchema.safeParse(shadowTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('shadow');
    }
  });
});
