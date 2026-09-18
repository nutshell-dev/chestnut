/**
 * phase 1863 (AT-D7)：SubAgentTask 的 opaque executor payload 契约。
 * （原 subagent-task-schema-shadow-fields.test.ts 改写：shadow 字段出 ATS schema，
 * 语义收进 owner payload；legacy shadow 任务读取经 zod strip 兼容。）
 */
import { describe, it, expect } from 'vitest';
import { SubAgentTaskSchema, TaskSchema } from '../../../src/core/async-task-system/task-schemas.js';

describe('SubAgentTaskSchema opaque executorPayload (phase 1863 AT-D7)', () => {
  const baseTask = {
    kind: 'subagent' as const,
    mode: 'standard' as const,
    id: '550e8400-e29b-41d4-a716-446655440000',
    shortId: '550e8400',
    intent: 'test intent',
    timeoutMs: 60_000,
    maxSteps: 100,
    parentClawId: 'parent-claw',
    createdAt: '2026-05-23T00:00:00Z',
  };

  it('plain subagent task without payload validates', () => {
    expect(SubAgentTaskSchema.safeParse(baseTask).success).toBe(true);
  });

  it('task with opaque executorPayload validates（任意 owner 形态）', () => {
    const withPayload = {
      ...baseTask,
      executorPayload: {
        systemPrompt: 'owner prompt',
        messages: [{ role: 'user', content: 'hi' }],
        identity: { shadowId: 'shadow-1', isShadow: true },
        detached: true,
      },
    };
    const parsed = SubAgentTaskSchema.safeParse(withPayload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.executorPayload).toEqual(withPayload.executorPayload);
    }
  });

  it('mode 缺省合法（opaque 可选；不静默注入）', () => {
    const { mode: _mode, ...withoutMode } = baseTask;
    const parsed = SubAgentTaskSchema.safeParse(withoutMode);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('mode' in parsed.data).toBe(false);
    }
  });

  it('legacy shadow task（mode=shadow + 4 shadow 字段）读取兼容（zod strip、不拒绝）', () => {
    const legacyShadow = {
      ...baseTask,
      mode: 'shadow',
      isShadow: true,
      shadowMessages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ],
      shadowSystemPrompt: 'motion system prompt',
      shadowToolsForLLM: [{ name: 'tool1', description: 'd', input_schema: {} }],
    };
    const parsed = SubAgentTaskSchema.safeParse(legacyShadow);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as Record<string, unknown>;
      expect('isShadow' in data).toBe(false);
      expect('shadowMessages' in data).toBe(false);
      expect('shadowSystemPrompt' in data).toBe(false);
      expect('shadowToolsForLLM' in data).toBe(false);
      expect(data.executorPayload).toBeUndefined();
    }
  });

  it('TaskSchema accepts subagent task with executorPayload', () => {
    const withPayload = {
      ...baseTask,
      executorPayload: { any: 'shape' },
    };
    expect(TaskSchema.safeParse(withPayload).success).toBe(true);
  });
});
