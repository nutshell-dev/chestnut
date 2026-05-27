import { describe, it, expect } from 'vitest';
import { validateTaskShape } from '../../../src/core/async-task-system/task-corrupt-helpers.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

describe('phase 1019 r124 E fork: TaskMeta zod strict schema', () => {
  it('rejects SubAgentTask with missing intent field (was previously accepted by 2-field discriminator)', () => {
    const corrupt = {
      kind: 'subagent',
      id: 'task-1',
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
      id: 'task-2',
      toolName: 'read',
      args: {},
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
      id: 'task-3',
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
