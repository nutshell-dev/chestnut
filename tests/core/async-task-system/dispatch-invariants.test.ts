/**
 * Merged test file (mechanical consolidation, no assertion changes).
 * Sources:
 *  - dispatch-latency.test.ts
 *  - schedule-write-failure.test.ts
 *  - move-failure-keeps-running.test.ts
 *  - running-file-delete-emit.test.ts
 *  - short-id-index-audit-json.test.ts
 *  - subagent-executor-abort-propagation.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeFullTaskId, deriveShortIdFromTaskId } from '../../../src/core/async-task-system/types.js';
import type { ShortIdIndex, AsyncTaskSystemOptions, SubAgentTask } from '../../../src/core/async-task-system/types.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { makeMockAudit } from '../../helpers/audit.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

// Kept at module scope: vi.hoisted variable (must stay hoisted; referenced only
// by the 'subagent-executor abort propagation' describe below).
const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn().mockResolvedValue({ text: 'done', capturedResult: undefined }),
}));

/**
 * Phase 1147 r127 B fork: dispatch latency invariant.
 *
 * Reverse test (latency floor): AsyncTaskSystem must use chokidar's
 * `stability: 'immediate'` mode so pending → ingest happens on the native
 * `add` event (not after a stabilityThreshold wait).
 *   - BEFORE revert ('stable'): ≥ 100ms (chokidar awaitWriteFinish settle)
 *   - AFTER revert ('immediate'): native fire, no settle
 *
 * Phase 1199 γ1 replaced the original wall-clock timing test with a
 * grep-based structural invariant (mirror phase 964 silent-x-invariant).
 *
 * Phase 1402 deleted the `atomic write invariant: non-.json files ignored`
 * sibling test: it depended on real FSEvents delivery within a 10s magic
 * timeout, was flaky under heavy parallel CI load, and did not actually
 * assert the negative ("ignored") branch it advertised.
 */

describe('AsyncTaskSystem dispatch latency (phase 1147 r127 B fork)', () => {
  it('AsyncTaskSystem 用 stability=immediate (regression guard for phase 1147 revert)', () => {
    const __filename = fileURLToPath(import.meta.url);
    // phase 16 Step A: watcher 拆出 pending-watcher.ts、stability 字符串随之迁移
    const watcherSrcPath = path.resolve(path.dirname(__filename), '../../../src/core/async-task-system/pending-watcher.ts');
    const src = readFileSync(watcherSrcPath, 'utf-8');
    expect(src).toMatch(/stability:\s*['"]immediate['"]/);
  });
});

/**
 * Phase 878: schedule() writeAtomic failure must not leave a dangling index entry.
 */

describe('phase 878: schedule writeAtomic failure index consistency', () => {
  function makeMockAudit(): AuditLog {
    return {
      write: vi.fn(),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
  }

  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let shortIdIndex: InMemoryShortIdIndex;
  let addSpy: ReturnType<typeof vi.spyOn>;
  let saveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shortIdIndex = new InMemoryShortIdIndex();
    addSpy = vi.spyOn(shortIdIndex, 'add');
    saveSpy = vi.spyOn(shortIdIndex, 'save');

    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      existsSync: vi.fn().mockReturnValue(false),
      listSync: vi.fn().mockReturnValue([]),
      exists: vi.fn().mockResolvedValue(false),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as FileSystem;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex,
      auditWriter: makeMockAudit(),
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    addSpy.mockRestore();
    saveSpy.mockRestore();
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('does not leave dangling index entry when task file write fails', async () => {
    await system.initialize();

    // initialize() legitimately saves the index after migration; clear before schedule.
    addSpy.mockClear();
    saveSpy.mockClear();

    await expect(
      system.schedule('subagent', {
        parentClawId: 'claw-1',
        parentClawDir: '/tmp/claw',
        goal: 'test goal',
        maxSteps: 10,
      } as any),
    ).rejects.toThrow('disk full');

    // Index must not have been touched because writeAtomic failed.
    expect(addSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();

    // No registered shortId in the index
    const registered = Array.from((shortIdIndex as any).map?.keys?.() ?? []);
    expect(registered.length).toBe(0);
  });
});

/**
 * Phase 871: moveTaskToDone / moveTaskToFailed failure must keep the running file
 * so that startup recovery can retry the move using the result.txt.sent marker.
 */

describe('phase 871: move failure keeps running file', () => {
  function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        events.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    return { audit, events };
  }

  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      move: vi.fn().mockRejectedValue(new Error('disk full')),
      delete: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.startsWith('tasks/queues/running/')) {
          return Promise.resolve(JSON.stringify({ id: 'task', kind: 'subagent' }));
        }
        return Promise.resolve('');
      }),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    const { audit, events } = makeMockAudit();
    auditEvents = events;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('moveTaskToDone failure does not delete the running file and persists terminalState=done', async () => {
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    const runningPath = `tasks/queues/running/${fullId}.json`;
    const donePath = `tasks/queues/done/${fullId}.json`;

    await (system as any).moveTaskToDone(fullId);

    // terminalState=done must be persisted before the move attempt
    const terminalStateWrites = (mockFs as any).writeAtomic.mock.calls.filter(
      ([filePath, content]: [string, string]) =>
        filePath === runningPath && content.includes('"terminalState":"done"'),
    );
    expect(terminalStateWrites.length).toBe(1);

    expect((mockFs as any).move).toHaveBeenCalledWith(runningPath, donePath);
    expect((mockFs as any).delete).not.toHaveBeenCalled();

    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED,
    );
    expect(moveFailedEvents.length).toBe(1);
    expect(moveFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.MOVE_FAILED,
        expect.stringContaining('context=move_to_done'),
      ]),
    );
  });

  it('moveTaskToFailed failure does not delete the running file and persists terminalState=failed', async () => {
    const fullId = makeFullTaskId('660e8400-e29b-41d4-a716-446655440000');
    const runningPath = `tasks/queues/running/${fullId}.json`;
    const failedPath = `tasks/queues/failed/${fullId}.json`;

    await (system as any).moveTaskToFailed(fullId);

    // terminalState=failed must be persisted before the move attempt
    const terminalStateWrites = (mockFs as any).writeAtomic.mock.calls.filter(
      ([filePath, content]: [string, string]) =>
        filePath === runningPath && content.includes('"terminalState":"failed"'),
    );
    expect(terminalStateWrites.length).toBe(1);

    expect((mockFs as any).move).toHaveBeenCalledWith(runningPath, failedPath);
    expect((mockFs as any).delete).not.toHaveBeenCalled();

    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED,
    );
    expect(moveFailedEvents.length).toBe(1);
    expect(moveFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.MOVE_FAILED,
        expect.stringContaining('context=move_to_failed'),
      ]),
    );
  });
});

/**
 * Phase 884: tool not found in registry must NOT delete the running file.
 * Instead it should persist terminalState=failed and attempt to move to failed/.
 */

describe('phase 884: tool not found keeps running file', () => {
  function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        events.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    return { audit, events };
  }

  function makeToolTaskJson(taskId: string): string {
    return JSON.stringify({
      kind: 'tool',
      id: taskId,
      toolName: 'nonexistent_tool',
      args: {},
      parentClawDir: '/tmp',
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
    });
  }

  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      delete: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('tasks/queues/running/') || filePath.includes('tasks/queues/pending/')) {
          const id = filePath.replace(/^.*\//, '').replace(/\.json$/, '');
          return Promise.resolve(makeToolTaskJson(id));
        }
        return Promise.resolve('');
      }),
      move: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    const { audit, events } = makeMockAudit();
    auditEvents = events;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('persists terminalState=failed and moves to failed dir instead of deleting', async () => {
    const taskId = 'tool-missing-move-ok';
    const runningPath = `tasks/queues/running/${taskId}.json`;
    const failedPath = `tasks/queues/failed/${taskId}.json`;

    await (system as any)._startTask(
      {
        kind: 'tool',
        id: taskId,
        toolName: 'nonexistent_tool',
        args: {},
        parentClawDir: '/tmp',
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
        isIdempotent: true,
        maxRetries: 0,
        retryCount: 0,
      },
      new AbortController().signal,
    );

    expect((mockFs as any).delete).not.toHaveBeenCalled();

    const terminalStateWrites = (mockFs as any).writeAtomic.mock.calls.filter(
      ([filePath, content]: [string, string]) =>
        filePath === runningPath && content.includes('"terminalState":"failed"'),
    );
    expect(terminalStateWrites.length).toBe(1);

    expect((mockFs as any).move).toHaveBeenCalledWith(runningPath, failedPath);

    const invariantEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.INVARIANT_VIOLATION && e.some(
        c => typeof c === 'string' && c.includes('kind=tool_not_found_registry'),
      ),
    );
    expect(invariantEvents.length).toBe(1);
    expect(invariantEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
        expect.stringContaining('toolName=nonexistent_tool'),
      ]),
    );
  });

  it('move failure keeps running file and emits MOVE_FAILED audit', async () => {
    const taskId = 'tool-missing-move-fail';
    const runningPath = `tasks/queues/running/${taskId}.json`;
    const failedPath = `tasks/queues/failed/${taskId}.json`;
    (mockFs as any).move = vi.fn().mockImplementation((from: string, to: string) => {
      if (to.includes('tasks/queues/failed/')) {
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(undefined);
    });

    await (system as any)._startTask(
      {
        kind: 'tool',
        id: taskId,
        toolName: 'nonexistent_tool',
        args: {},
        parentClawDir: '/tmp',
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
        isIdempotent: true,
        maxRetries: 0,
        retryCount: 0,
      },
      new AbortController().signal,
    );

    expect((mockFs as any).delete).not.toHaveBeenCalled();

    const terminalStateWrites = (mockFs as any).writeAtomic.mock.calls.filter(
      ([filePath, content]: [string, string]) =>
        filePath === runningPath && content.includes('"terminalState":"failed"'),
    );
    expect(terminalStateWrites.length).toBe(1);

    expect((mockFs as any).move).toHaveBeenCalledWith(runningPath, failedPath);

    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(
        c => typeof c === 'string' && c.includes('context=tool_not_found_move_to_failed'),
      ),
    );
    expect(moveFailedEvents.length).toBe(1);
    expect(moveFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.MOVE_FAILED,
        expect.stringContaining('fullTaskId='),
        expect.stringContaining('shortTaskId='),
        expect.stringContaining('context=tool_not_found_move_to_failed'),
        expect.stringContaining('error='),
      ]),
    );

    const fullTaskIdCol = moveFailedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('fullTaskId='),
    );
    expect(fullTaskIdCol).toContain(taskId);
    const shortTaskIdCol = moveFailedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('shortTaskId='),
    );
    expect(shortTaskIdCol).toContain(deriveShortIdFromTaskId(taskId as any));
    const errorCol = moveFailedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('error='),
    );
    expect(errorCol).toContain('disk full');
  });
});

/**
 * Phase 858: shortIdIndexAuditWriter serializes complex values with JSON.stringify.
 */

describe('shortIdIndexAuditWriter JSON serialization (phase 858)', () => {
  function makeMockFs(): FileSystem {
    return {
      existsSync: vi.fn(() => false),
      listSync: vi.fn(() => []),
    } as unknown as FileSystem;
  }

  function makeMockAudit(): AuditLog {
    return {
      write: vi.fn(),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    } as unknown as AuditLog;
  }

  function makeMockShortIdIndex(): ShortIdIndex {
    return {
      needsRebuild: false,
      load: vi.fn(),
      save: vi.fn(),
      resolve: vi.fn(),
      add: vi.fn(),
      rebuildFromDisk: vi.fn(),
    } as unknown as ShortIdIndex;
  }

  function makeSystem(audit: AuditLog): AsyncTaskSystem {
    const fs = makeMockFs();
    const options: AsyncTaskSystemOptions = {
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: { getAll: vi.fn(() => []) } as any,
      fsFactory: () => fs,
      askMotionToolFactory: () => ({} as any),
      shortIdIndex: makeMockShortIdIndex(),
    };
    return new AsyncTaskSystem('/tmp', fs, options);
  }

  it('serializes string/number/boolean with String() (no extra quotes)', () => {
    const audit = makeMockAudit();
    const system = makeSystem(audit);
    const writer = (system as any).shortIdIndexAuditWriter;

    writer.write('test_event', {
      str: 'hello',
      num: 42,
      bool: true,
    });

    expect(audit.write).toHaveBeenCalledWith(
      'test_event',
      'str=hello',
      'num=42',
      'bool=true',
    );
  });

  it('serializes object/array with JSON.stringify', () => {
    const audit = makeMockAudit();
    const system = makeSystem(audit);
    const writer = (system as any).shortIdIndexAuditWriter;

    writer.write('short_id_collision', {
      collisions: [
        { shortId: 'abc', existingFullId: 'id-1', conflictingFullId: 'id-2' },
      ],
      entryCount: 3,
    });

    const callArgs = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
    expect(callArgs[0]).toBe('short_id_collision');
    const collisionsCol = callArgs.find(a => typeof a === 'string' && a.startsWith('collisions='));
    expect(collisionsCol).toBeDefined();
    const json = collisionsCol!.slice('collisions='.length);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([
      { shortId: 'abc', existingFullId: 'id-1', conflictingFullId: 'id-2' },
    ]);
    expect(callArgs).toContain('entryCount=3');
  });
});

/**
 * task abort signal propagation to runSubagent (phase 1373 sub-5)
 */

describe('subagent-executor abort propagation (phase 1373 sub-5)', () => {
  beforeEach(() => {
    mockRunSubagent.mockClear();
  });

  it('task abort signal 应 cascade 到 runSubagent 的 signal 参数', async () => {
    const abortController = new AbortController();
    const task: SubAgentTask = {
      kind: 'subagent',
      id: '550e8400-e29b-41d4-a716-446655440000',
      shortId: '550e8400',
      mode: 'standard',
      intent: 'test intent',
      timeoutMs: 300_000,
      maxSteps: 100,
      parentClawId: 'claw-a',
      createdAt: new Date().toISOString(),
    };

    await executeSubAgentTask(task, abortController.signal, {
      fs: {
        ensureDirSync: vi.fn(),
        readSync: vi.fn().mockReturnValue(''),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
        existsSync: vi.fn().mockReturnValue(true),
        listSync: vi.fn().mockReturnValue([]),
        deleteSync: vi.fn(),
        move: vi.fn().mockResolvedValue(undefined),
      } as any,
      fsFactory: vi.fn().mockReturnValue({} as any),
      auditWriter: makeMockAudit(),
      llm: {} as any,
      registry: {
        formatForLLM: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(undefined),
        getForProfile: vi.fn().mockReturnValue([]),
      } as any,
      clawDir: '/tmp/test',
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      askMotionToolFactory: vi.fn().mockReturnValue({} as any),
      runSubagent: mockRunSubagent,
    });

    expect(mockRunSubagent).toHaveBeenCalled();
    const callArg = mockRunSubagent.mock.calls[0][0];
    expect(callArg.signal).toBeDefined();
    expect(callArg.signal).toBeInstanceOf(AbortSignal);
  });

  it('pre-aborted signal 应仍传给 runSubagent', async () => {
    const abortController = new AbortController();
    abortController.abort('test abort');

    const task: SubAgentTask = {
      kind: 'subagent',
      id: '550e8401-e29b-41d4-a716-446655440000',
      shortId: '550e8401',
      mode: 'standard',
      intent: 'test intent',
      timeoutMs: 300_000,
      maxSteps: 100,
      parentClawId: 'claw-a',
      createdAt: new Date().toISOString(),
    };

    await executeSubAgentTask(task, abortController.signal, {
      fs: {
        ensureDirSync: vi.fn(),
        readSync: vi.fn().mockReturnValue(''),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
        existsSync: vi.fn().mockReturnValue(true),
        listSync: vi.fn().mockReturnValue([]),
        deleteSync: vi.fn(),
        move: vi.fn().mockResolvedValue(undefined),
      } as any,
      fsFactory: vi.fn().mockReturnValue({} as any),
      auditWriter: makeMockAudit(),
      llm: {} as any,
      registry: {
        formatForLLM: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(undefined),
        getForProfile: vi.fn().mockReturnValue([]),
      } as any,
      clawDir: '/tmp/test',
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      askMotionToolFactory: vi.fn().mockReturnValue({} as any),
      runSubagent: mockRunSubagent,
    });

    expect(mockRunSubagent).toHaveBeenCalled();
    const callArg = mockRunSubagent.mock.calls[0][0];
    expect(callArg.signal).toBeDefined();
    expect(callArg.signal.aborted).toBe(true);
  });
});
