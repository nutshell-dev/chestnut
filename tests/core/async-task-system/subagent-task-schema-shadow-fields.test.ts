import { describe, it, expect } from 'vitest';
import { SubAgentTaskSchema, TaskSchema } from '../../../src/core/async-task-system/task-schemas.js';

describe('SubAgentTaskSchema phase 1087 shadow fields (phase 1131)', () => {
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

  it('plain subagent task without shadow fields validates', () => {
    expect(SubAgentTaskSchema.safeParse(baseTask).success).toBe(true);
  });

  it('shadow async task with all 4 shadow fields validates', () => {
    const shadowTask = {
      ...baseTask,
      isShadow: true,
      shadowMessages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ],
      shadowSystemPrompt: 'motion system prompt',
      shadowToolsForLLM: [
        { name: 'tool1', description: 'd', input_schema: {} },
      ],
    };
    expect(SubAgentTaskSchema.safeParse(shadowTask).success).toBe(true);
  });

  it('shadow fields are optional individually', () => {
    expect(SubAgentTaskSchema.safeParse({ ...baseTask, isShadow: true }).success).toBe(true);
    expect(SubAgentTaskSchema.safeParse({ ...baseTask, shadowMessages: [] }).success).toBe(true);
    expect(SubAgentTaskSchema.safeParse({ ...baseTask, shadowSystemPrompt: '' }).success).toBe(true);
    expect(SubAgentTaskSchema.safeParse({ ...baseTask, shadowToolsForLLM: [] }).success).toBe(true);
  });

  it('rejects wrong types for shadow fields', () => {
    expect(SubAgentTaskSchema.safeParse({ ...baseTask, isShadow: 'yes' }).success).toBe(false);
    expect(SubAgentTaskSchema.safeParse({ ...baseTask, shadowMessages: 'not-array' }).success).toBe(false);
    expect(SubAgentTaskSchema.safeParse({ ...baseTask, shadowSystemPrompt: 123 }).success).toBe(false);
    expect(SubAgentTaskSchema.safeParse({ ...baseTask, shadowToolsForLLM: {} }).success).toBe(false);
  });

  it('TaskSchema discriminated union accepts shadow subagent task', () => {
    const shadowTask = {
      ...baseTask,
      isShadow: true,
      shadowMessages: [],
      shadowSystemPrompt: 'sp',
      shadowToolsForLLM: [],
    };
    expect(TaskSchema.safeParse(shadowTask).success).toBe(true);
  });
});
