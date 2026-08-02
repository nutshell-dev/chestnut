/**
 * Phase 1269 Step E — ToolTaskSchema migrated execution identity.
 *
 * - New v1 execution-group identity files must parse.
 * - Legacy PID-only files must stay loadable until they drain naturally.
 * - A migrated task without any identity is corrupt (fail-observable).
 * - Unknown/future protocol versions must fail parsing — never guessed.
 */

import { describe, it, expect } from 'vitest';
import { ToolTaskSchema } from '../../../src/core/async-task-system/task-schemas.js';

function makeBaseTask(extra: Record<string, unknown> = {}) {
  return {
    kind: 'tool',
    id: '550e8400-e29b-41d4-a716-446655440000',
    shortId: '550e8400',
    toolName: 'exec',
    args: { command: 'sleep 1' },
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
    ...extra,
  };
}

describe('phase 1269 Step E: ToolTaskSchema migrated execution identity', () => {
  it('parses a v1 execution-group identity', () => {
    const task = makeBaseTask({
      mode: 'migrated',
      migratedExecution: {
        version: 1,
        leaderPid: 12345,
        processGroupId: 12345,
        leaderStartTime: 'Mon Jan 01 00:00:00 2020',
      },
      migratedDeadlineMs: 123,
    });
    const parsed = ToolTaskSchema.safeParse(task);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.migratedExecution?.version).toBe(1);
      expect(parsed.data.migratedExecution?.processGroupId).toBe(12345);
    }
  });

  it('parses a v1 identity without leaderStartTime (explicitly unverifiable)', () => {
    const task = makeBaseTask({
      mode: 'migrated',
      migratedExecution: { version: 1, leaderPid: 12345, processGroupId: 12345 },
    });
    expect(ToolTaskSchema.safeParse(task).success).toBe(true);
  });

  it('still parses a legacy PID-only migrated file', () => {
    const task = makeBaseTask({
      mode: 'migrated',
      migratedPid: 12345,
      migratedStartTime: 'Mon Jan 01 00:00:00 2020',
    });
    const parsed = ToolTaskSchema.safeParse(task);
    expect(parsed.success).toBe(true);
  });

  it('rejects a migrated task without any execution identity', () => {
    const task = makeBaseTask({ mode: 'migrated' });
    const parsed = ToolTaskSchema.safeParse(task);
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown/future identity version', () => {
    const task = makeBaseTask({
      mode: 'migrated',
      migratedExecution: { version: 2, leaderPid: 12345, processGroupId: 12345 },
    });
    expect(ToolTaskSchema.safeParse(task).success).toBe(false);
  });

  it('parses a non-migrated task without any identity', () => {
    expect(ToolTaskSchema.safeParse(makeBaseTask()).success).toBe(true);
    expect(ToolTaskSchema.safeParse(makeBaseTask({ mode: 'fresh' })).success).toBe(true);
  });
});
