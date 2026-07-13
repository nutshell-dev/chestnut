import { describe, it, expect } from 'vitest';
import { validateTaskShape } from '../../../src/core/async-task-system/task-corrupt-helpers.js';
import { SubAgentTaskSchema } from '../../../src/core/async-task-system/task-schemas.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

describe('phase 1019 r124 E fork: TaskMeta zod strict schema', () => {
  it('rejects SubAgentTask with missing intent field (was previously accepted by 2-field discriminator)', () => {
    const corrupt = {
      kind: 'subagent',
      id: '550e8400-e29b-41d4-a716-446655440000',
      shortId: '550e8400',
      // intent missing
      timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
      maxSteps: 10,
      parentClawId: 'claw-1',
      createdAt: '2026-05-18T00:00:00Z',
    };
    expect(validateTaskShape(corrupt)).toBe(false);
  });

  it('rejects ToolTask with wrong type for retryCount (string instead of number)', () => {
    const corrupt = {
      kind: 'tool',
      id: '550e8401-e29b-41d4-a716-446655440000',
      shortId: '550e8401',
      toolName: 'read',
      args: {},
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      parentClawDir: '/tmp',
      parentClawId: 'claw-1',
      createdAt: '2026-05-18T00:00:00Z',
      isIdempotent: true,
      maxRetries: 2,
      retryCount: 'zero',  // 错类型
    };
    expect(validateTaskShape(corrupt)).toBe(false);
  });

  it('accepts valid SubAgentTask with all required + optional fields', () => {
    const valid = {
      kind: 'subagent',
      mode: 'standard',
      id: '550e8402-e29b-41d4-a716-446655440000',
      shortId: '550e8402',
      intent: 'do something',
      timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
      maxSteps: 10,
      parentClawId: 'claw-1',
      createdAt: '2026-05-18T00:00:00Z',
      systemPrompt: 'optional prompt',
    };
    expect(validateTaskShape(valid)).toBe(true);
  });
});


describe('phase 311 ML#9 strict: SubAgentTaskSchema no silent preprocess', () => {
  it('rejects SubAgentTask missing mode field (no silent inject standard)', () => {
    const corrupt = {
      kind: 'subagent',
      id: '550e8403-e29b-41d4-a716-446655440000',
      shortId: '550e8403',
      intent: 'do something',
      timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
      maxSteps: 10,
      parentClawId: 'claw-1',
      createdAt: '2026-05-18T00:00:00Z',
    };
    expect(SubAgentTaskSchema.safeParse(corrupt).success).toBe(false);
    expect(validateTaskShape(corrupt)).toBe(false);
  });

  it('rejects SubAgentTask with intentPreview field (no silent rename to intent)', () => {
    const corrupt = {
      kind: 'subagent',
      id: '550e8404-e29b-41d4-a716-446655440000',
      shortId: '550e8404',
      intentPreview: 'old intent field',
      mode: 'shadow',
      timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
      maxSteps: 10,
      parentClawId: 'claw-1',
      createdAt: '2026-05-18T00:00:00Z',
      shadowMessages: [],
    };
    expect(SubAgentTaskSchema.safeParse(corrupt).success).toBe(false);
    expect(validateTaskShape(corrupt)).toBe(false);
  });
});
