/**
 * Phase 1269 Step E — ToolTaskSchema migrated execution identity.
 *
 * - New v1 execution-group identity files must parse.
 * - Legacy PID-only files must stay loadable until they drain naturally.
 * - Execution identity remains opaque to ATS; ProcessExec owns validation.
 * - Missing/malformed/future identities remain recoverable artifacts.
 */

import { describe, it, expect } from 'vitest';
import { SubAgentTaskSchema, ToolTaskSchema } from '../../../src/core/async-task-system/task-schemas.js';

describe('phase 1479 Step B: mainContextSnapshot legacy strip compat', () => {
  it('旧 JSON 含 mainContextSnapshot → parse 成功且输出不含该字段（zod strip 行为）', () => {
    const legacy = {
      kind: 'subagent',
      mode: 'standard',
      id: '550e8400-e29b-41d4-a716-446655440000',
      shortId: '550e8400',
      intent: 'legacy task with marker snapshot',
      timeoutMs: 1000, // time-fixture: configuration/payload round-trip input, not an independent wait budget
      parentClawId: 'p1',
      createdAt: new Date().toISOString(),
      mainContextSnapshot: { clawId: 'c1', toolUseId: 'tu-1' },
    };
    const parsed = SubAgentTaskSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('mainContextSnapshot' in parsed.data).toBe(false);
    }
  });
});

describe('phase 1863 Step D (AT-D6): motionClawDir legacy strip compat', () => {
  it('旧 JSON 含 motionClawDir → parse 成功且输出不含该字段（zod strip、读取不拒绝）', () => {
    const legacy = {
      kind: 'subagent',
      mode: 'standard',
      id: '550e8400-e29b-41d4-a716-446655440000',
      shortId: '550e8400',
      intent: 'legacy task with motionClawDir',
      timeoutMs: 1000, // time-fixture: configuration/payload round-trip input, not an independent wait budget
      parentClawId: 'p1',
      createdAt: new Date().toISOString(),
      motionClawDir: '/tmp/motion-claw',
    };
    const parsed = SubAgentTaskSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('motionClawDir' in parsed.data).toBe(false);
    }
  });
});

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
      expect(parsed.data.migratedExecution).toMatchObject({
        version: 1,
        processGroupId: 12345,
      });
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

  it('keeps a migrated task without identity loadable for observable recovery', () => {
    const task = makeBaseTask({ mode: 'migrated' });
    expect(ToolTaskSchema.safeParse(task).success).toBe(true);
  });

  it('keeps an unknown/future identity version opaque for L1 decode', () => {
    const task = makeBaseTask({
      mode: 'migrated',
      migratedExecution: { version: 2, leaderPid: 12345, processGroupId: 12345 },
    });
    expect(ToolTaskSchema.safeParse(task).success).toBe(true);
  });

  it('parses a non-migrated task without any identity', () => {
    expect(ToolTaskSchema.safeParse(makeBaseTask()).success).toBe(true);
    expect(ToolTaskSchema.safeParse(makeBaseTask({ mode: 'fresh' })).success).toBe(true);
  });

  it('does not interpret the v1 PGID invariant in the ATS schema', () => {
    const task = makeBaseTask({
      mode: 'migrated',
      migratedExecution: { version: 1, leaderPid: 12345, processGroupId: 12346 },
    });
    expect(ToolTaskSchema.safeParse(task).success).toBe(true);
  });

  it('keeps non-integer and unsafe identity values opaque for L1 rejection', () => {
    expect(ToolTaskSchema.safeParse(makeBaseTask({
      mode: 'migrated',
      migratedExecution: { version: 1, leaderPid: 123.5, processGroupId: 123.5 },
    })).success).toBe(true);

    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(ToolTaskSchema.safeParse(makeBaseTask({
      mode: 'migrated',
      migratedExecution: { version: 1, leaderPid: unsafe, processGroupId: unsafe },
    })).success).toBe(true);
  });

  it('keeps dangerous small values opaque for L1 rejection', () => {
    for (const pid of [0, 1, -5]) {
      expect(ToolTaskSchema.safeParse(makeBaseTask({
        mode: 'migrated',
        migratedExecution: { version: 1, leaderPid: pid, processGroupId: pid },
      })).success).toBe(true);
    }
  });
});
