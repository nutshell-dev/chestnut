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
import { makeShortTaskId } from '../../../src/core/async-task-system/types.js';

// 反向 1 — tsc enforce 非法组合（compile-time）
describe('SubAgentTask discriminated union (phase 1185)', () => {
  it('ts-expect-error: shadow variant 不允许缺少 shadowMessages', () => {
    // @ts-expect-error shadow variant 必须提供 shadowMessages
    const _badShadow: SubAgentTask = {
      mode: 'shadow',
      intent: 'x',
      kind: 'subagent',
      id: 't1',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    expect(_badShadow).toBeDefined();
  });

  it('ts-expect-error: standard variant 不允许 shadowMessages', () => {
    // @ts-expect-error standard variant 不允许 shadowMessages
    const _badStandard: SubAgentTask = {
      mode: 'standard',
      intent: 'do Y',
      shadowMessages: [],
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
      intent: 'hi',
      kind: 'subagent',
      id: 't3',
      shortId: makeShortTaskId('shortt3'),
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
      shortId: makeShortTaskId('shortt4'),
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    expect(_goodStandard.mode).toBe('standard');
  });
});

// 反向 4 — phase 311 ML#9 strict: 删 preprocess hook、旧 schema 直接 reject
describe('SubAgentTaskSchema phase 311 strict (no silent preprocess)', () => {
  it('rejects old pendingTask without mode field', () => {
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
    expect(result.success).toBe(false);
  });

  it('shadow task 含 mode=shadow 正常 parse', () => {
    const shadowTask = {
      kind: 'subagent',
      mode: 'shadow',
      id: '550e8400-e29b-41d4-a716-446655440000',
      shortId: '550e8400',
      shadowMessages: [{ role: 'user', content: 'hi' }],
      intent: 'hi',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    const result = SubAgentTaskSchema.safeParse(shadowTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('shadow');
      expect(result.data.intent).toBe('hi');
    }
  });

  it('rejects old shadow task with intentPreview field (no silent rename)', () => {
    const oldShadowTask = {
      kind: 'subagent',
      mode: 'shadow',
      id: 'old-shadow-task',
      shadowMessages: [{ role: 'user', content: 'hi' }],
      intentPreview: 'legacy intent',
      timeoutMs: 60_000,
      maxSteps: 10,
      parentClawId: 'c1',
      createdAt: '2026-05-24T00:00:00Z',
    };
    const result = SubAgentTaskSchema.safeParse(oldShadowTask);
    expect(result.success).toBe(false);
  });
});
