/**
 * Phase 858: async ToolTask isShadow propagation round-trip
 *
 * Verifies 4-site fix:
 *   (a) AsyncToolTaskArgs interface carries isShadow
 *   (b) ToolTask interface carries isShadow
 *   (c) executor.scheduleAsyncTool call propagates ctx.isShadow
 *   (d) buildToolTaskExecContext rebuilds ctx.isShadow from task.isShadow
 */

import { describe, it, expect, vi } from 'vitest';
import { writePendingToolTaskFile } from '../../../src/core/async-task-system/tools/_pending-tool-task-writer.js';
import { AsyncTaskSystem, type ToolTask } from '../../../src/core/async-task-system/system.js';
import { createTestTaskSystem } from '../../helpers/task-system.js';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog, AuditWriter } from '../../../src/foundation/audit/index.js';
import type { ExecContext } from '../../../src/foundation/tool-protocol/index.js';
import type { AsyncToolTaskArgs } from '../../../src/foundation/tools/async-dispatch.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
  return { audit, events };
}

function makeCapturingMockFs(): FileSystem & { captured: Array<{ path: string; content: string }> } {
  const captured: Array<{ path: string; content: string }> = [];
  const fs = {
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockImplementation((path: string) => {
      const entry = captured.find((c) => c.path === path);
      return Promise.resolve(entry?.content ?? '{}');
    }),
    exists: vi.fn().mockResolvedValue(false),
    move: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
      captured.push({ path, content });
      return Promise.resolve(undefined);
    }),
    resolve: vi.fn((p: string) => `/abs/${p}`),
  } as unknown as FileSystem & { captured: Array<{ path: string; content: string }> };
  fs.captured = captured;
  return fs;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('async ToolTask isShadow propagation (phase 858)', () => {
  it('writePendingToolTaskFile serializes isShadow=true when provided', async () => {
    const fs = makeCapturingMockFs();
    const { audit } = makeMockAudit();

    await writePendingToolTaskFile(fs, audit, {
      toolName: 'test_tool',
      args: { x: 1 },
      parentClawDir: '/tmp/claw',
      parentClawId: 'claw-1',
      isIdempotent: true,
      maxRetries: 2,
      retryCount: 0,
      isShadow: true,
    });

    expect(fs.captured.length).toBe(1);
    const written = JSON.parse(fs.captured[0].content);
    expect(written.isShadow).toBe(true);
  });

  it('writePendingToolTaskFile omits isShadow when not provided (undefined)', async () => {
    const fs = makeCapturingMockFs();
    const { audit } = makeMockAudit();

    await writePendingToolTaskFile(fs, audit, {
      toolName: 'test_tool',
      args: { x: 1 },
      parentClawDir: '/tmp/claw',
      parentClawId: 'claw-1',
      isIdempotent: true,
      maxRetries: 2,
      retryCount: 0,
    });

    expect(fs.captured.length).toBe(1);
    const written = JSON.parse(fs.captured[0].content);
    expect(written.isShadow).toBeUndefined();
  });

  it('buildToolTaskExecContext restores isShadow=true from shadow task', () => {
    const fs = makeCapturingMockFs();
    const { audit } = makeMockAudit();
    const system = createTestTaskSystem('/tmp/claw', fs, audit as AuditWriter);

    const task: ToolTask = {
      kind: 'tool',
      id: 'task-1',
      toolName: 'spawn',
      args: {},
      parentClawDir: '/tmp/claw',
      parentClawId: 'claw-1',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 2,
      retryCount: 0,
      isShadow: true,
    };

    // Access private method via type assertion for test verification
    const ctx = (system as unknown as {
      buildToolTaskExecContext(task: ToolTask, signal: AbortSignal): ExecContext;
    }).buildToolTaskExecContext(task, new AbortController().signal);

    expect(ctx.isShadow).toBe(true);
  });

  it('buildToolTaskExecContext restores isShadow=undefined from non-shadow task', () => {
    const fs = makeCapturingMockFs();
    const { audit } = makeMockAudit();
    const system = createTestTaskSystem('/tmp/claw', fs, audit as AuditWriter);

    const task: ToolTask = {
      kind: 'tool',
      id: 'task-2',
      toolName: 'summon',
      args: {},
      parentClawDir: '/tmp/claw',
      parentClawId: 'claw-1',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 2,
      retryCount: 0,
    };

    const ctx = (system as unknown as {
      buildToolTaskExecContext(task: ToolTask, signal: AbortSignal): ExecContext;
    }).buildToolTaskExecContext(task, new AbortController().signal);

    expect(ctx.isShadow).toBeUndefined();
  });

  it('round-trip: shadow ctx args → file → load → ctx rebuild keeps isShadow=true', async () => {
    const fs = makeCapturingMockFs();
    const { audit } = makeMockAudit();

    // Step 1: schedule writes the file
    await writePendingToolTaskFile(fs, audit, {
      toolName: 'spawn',
      args: {},
      parentClawDir: '/tmp/claw',
      parentClawId: 'claw-1',
      isIdempotent: true,
      maxRetries: 2,
      retryCount: 0,
      callerType: 'claw',
      isShadow: true,
    });

    expect(fs.captured.length).toBe(1);
    const fileContent = fs.captured[0].content;
    const parsed = JSON.parse(fileContent) as ToolTask;
    expect(parsed.isShadow).toBe(true);

    // Step 2: rebuild ctx from loaded task
    const system = createTestTaskSystem('/tmp/claw', fs, audit as AuditWriter);
    const ctx = (system as unknown as {
      buildToolTaskExecContext(task: ToolTask, signal: AbortSignal): ExecContext;
    }).buildToolTaskExecContext(parsed, new AbortController().signal);

    expect(ctx.isShadow).toBe(true);
  });

  it('executor.execute async path propagates ctx.isShadow to scheduleAsyncTool args', async () => {
    const registry = new ToolRegistryImpl();
    registry.register({
      name: 'async_test_tool',
      description: 'test',
      schema: { type: 'object', properties: {} },
      execute: vi.fn(),
      idempotent: true,
      supportsAsync: true,
      group: 'fs-read',
    } as any);

    let capturedArgs: AsyncToolTaskArgs | undefined;
    const scheduleAsyncTool = vi.fn(async (args: AsyncToolTaskArgs) => {
      capturedArgs = args;
      return 'task-id-123';
    });

    const executor = new ToolExecutorImpl(registry, 60000, scheduleAsyncTool);

    const shadowCtx: ExecContext = {
      clawId: 'claw-1',
      clawDir: '/tmp/claw',
      workspaceDir: '/tmp/claw/clawspace',
      syncDir: '/tmp/claw/.sync',
      callerType: 'claw',
      allowedGroups: new Set(['fs-read']),
      callerLabel: 'claw',
      fs: makeCapturingMockFs(),
      profile: 'full',
      stepNumber: 0,
      maxSteps: 1,
      isShadow: true,
      isMotionChain: false,
      getElapsedMs: () => 0,
      incrementStep: vi.fn(),
      stopRequested: false,
      requestStop: vi.fn(),
      fullyReadPaths: new Set(),
    };

    const result = await executor.execute({
      toolName: 'async_test_tool',
      args: {},
      ctx: shadowCtx,
      async: true,
    });

    expect(result.success).toBe(true);
    expect(scheduleAsyncTool).toHaveBeenCalledTimes(1);
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.isShadow).toBe(true);
  });
});

describe('writePendingToolTaskFile - audit emit isShadow attr (phase 893)', () => {
  it('emits isShadow=true when args.isShadow=true', async () => {
    const fs = makeCapturingMockFs();
    const { audit, events } = makeMockAudit();

    await writePendingToolTaskFile(fs, audit, {
      toolName: 'fake_tool',
      args: {},
      parentClawDir: '/tmp/claw',
      parentClawId: 'claw-a',
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
      isShadow: true,
    });

    const scheduled = events.find((e) => e[0] === 'task_scheduled');
    expect(scheduled).toBeDefined();
    expect(scheduled!.slice(1)).toContain('isShadow=true');
  });

  it('emits isShadow=false when args.isShadow=false', async () => {
    const fs = makeCapturingMockFs();
    const { audit, events } = makeMockAudit();

    await writePendingToolTaskFile(fs, audit, {
      toolName: 'fake_tool',
      args: {},
      parentClawDir: '/tmp/claw',
      parentClawId: 'claw-a',
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
      isShadow: false,
    });

    const scheduled = events.find((e) => e[0] === 'task_scheduled');
    expect(scheduled).toBeDefined();
    expect(scheduled!.slice(1)).toContain('isShadow=false');
  });

  it('emits isShadow=undefined when args.isShadow omitted', async () => {
    const fs = makeCapturingMockFs();
    const { audit, events } = makeMockAudit();

    await writePendingToolTaskFile(fs, audit, {
      toolName: 'fake_tool',
      args: {},
      parentClawDir: '/tmp/claw',
      parentClawId: 'claw-a',
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
    });

    const scheduled = events.find((e) => e[0] === 'task_scheduled');
    expect(scheduled).toBeDefined();
    expect(scheduled!.slice(1)).toContain('isShadow=undefined');
  });
});
