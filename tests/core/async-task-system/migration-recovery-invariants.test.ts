/**
 * Merged: migration recovery invariants.
 * Sources:
 * - phase886.test.ts
 * - phase887.test.ts
 * - phase889.test.ts
 * - phase902.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex, PersistentShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_FAILED_DIR, TASKS_QUEUES_RESULTS_DIR } from '../../../src/core/async-task-system/dirs.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { sendToolResult, sendResult, sendFallbackError, SENT_MARKER } from '../../../src/core/async-task-system/result-delivery.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendResult: vi.fn().mockResolvedValue(undefined),
  sendFallbackError: vi.fn().mockResolvedValue(undefined),
  sendToolResult: vi.fn().mockResolvedValue(undefined),
  SENT_MARKER: (taskId: string) => `tasks/queues/results/${taskId}/result.txt.sent`,
}));

/**
 * Phase 886: overflow parent notification + move propagation + corrupt cancel + cap boundary.
 */
describe('phase 886', () => {
  function makeAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => events.push([type, ...cols]),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    return { audit, events };
  }

  let baseDir: string;

  function setupBaseDir(): void {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    baseDir = path.join(tmpdir(), `phase886-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(baseDir, { recursive: true });
    for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
      fs.mkdirSync(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
    }
    fs.mkdirSync(path.join(baseDir, 'sync'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'inbox', 'pending'), { recursive: true });
  }

  function writePendingFile(baseDir: string, id: string, extra: Record<string, unknown> = {}): void {
    const p = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${id}.json`);
    fs.writeFileSync(p, JSON.stringify({
      id,
      shortId: id.length === 36 ? id.slice(0, 8) : id,
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
      ...extra,
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  });

  it('sends fallback error to parent on overflow', async () => {
    setupBaseDir();
    const { audit } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
      pendingQueueMax: 3,
    });

    writePendingFile(baseDir, 'overflow-task');
    for (let i = 0; i < 3; i++) {
      writePendingFile(baseDir, `task-${i}`);
    }

    await (system as any)._enqueueAndDispatch({
      id: 'overflow-task',
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
    } as any);

    expect(sendFallbackError).toHaveBeenCalledTimes(1);
    const callArgs = (sendFallbackError as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[2]).toMatchObject({ id: 'overflow-task' });
    expect(callArgs[3]).toContain('pending queue overflow');

    const failedFile = path.join(baseDir, TASKS_QUEUES_FAILED_DIR, 'overflow-task.json');
    expect(fs.existsSync(failedFile)).toBe(true);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('keeps task in pending and retries move on next dispatch cycle when overflow move fails', async () => {
    setupBaseDir();
    const { audit, events } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });

    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
      pendingQueueMax: 3,
    });

    // Use a UUID-length task id so _loadTaskFromFile can validate the shape on retry.
    const taskId = '550e8400-e29b-41d4-a716-446655440000';

    // Replace move with one that rejects for the overflow path only.
    let moveAttempts = 0;
    const originalMove = realFs.move.bind(realFs);
    realFs.move = async (from: string, to: string) => {
      if (from.includes(`tasks/queues/pending/${taskId}.json`)) {
        moveAttempts++;
        if (moveAttempts === 1) {
          const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
          throw err;
        }
      }
      return originalMove(from, to);
    };

    writePendingFile(baseDir, taskId);
    for (let i = 0; i < 3; i++) {
      writePendingFile(baseDir, `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);
    }

    // Phase 887: overflow move failure no longer throws; the task stays in pending
    // with terminalState='failed' and is retried on the next dispatch cycle.
    await (system as any)._enqueueAndDispatch({
      id: taskId,
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
    } as any);

    const moveFailedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cap_overflow_move')),
    );
    expect(moveFailedEvents.length).toBe(1);

    // Task file must remain in pending so the dispatcher can retry.
    const pendingFile = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${taskId}.json`);
    expect(fs.existsSync(pendingFile)).toBe(true);
    const pendingContent = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
    expect(pendingContent.terminalState).toBe('failed');

    // Next dispatch cycle: _getPendingTasks sees terminalState='failed' and retries.
    const pendingTasks = await (system as any)._getPendingTasks();
    expect(pendingTasks.some((t: { id: string }) => t.id === taskId)).toBe(false);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`))).toBe(true);
    expect(fs.existsSync(pendingFile)).toBe(false);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('does not report race-lost when task was backed up as corrupt', async () => {
    setupBaseDir();
    const { audit, events } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
    });

    // Use a UUID-length task id so _resolveFullTaskId accepts it without a ShortIdIndex entry.
    const taskId = '550e8400-e29b-41d4-a716-446655440000';
    // Seed a corrupt backup in pending; original file is gone after backupCorruptTask atomic move.
    const backupPath = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${taskId}.json.corrupt-12345`);
    fs.writeFileSync(backupPath, JSON.stringify({ id: taskId, kind: 'bogus' }));

    await system.cancel(taskId);

    const raceLostEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.TASK_CANCEL_RACE_LOST_TO_DISPATCH,
    );
    expect(raceLostEvents.length).toBe(0);

    const cancelledEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some(c => typeof c === 'string' && c === `fullTaskId=${taskId}`),
    );
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0]).toEqual(
      expect.arrayContaining([expect.stringContaining('from=pending_corrupt')]),
    );

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('accepts the MAX-th task and rejects the MAX+1-th (off-by-one fix)', async () => {
    setupBaseDir();
    const { audit } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
      pendingQueueMax: 3,
    });

    // Fill to MAX-1.
    for (let i = 0; i < 2; i++) {
      writePendingFile(baseDir, `task-${i}`);
    }

    // MAX-th task is accepted.
    writePendingFile(baseDir, 'max-task');
    await (system as any)._enqueueAndDispatch({
      id: 'max-task',
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
    } as any);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, 'max-task.json'))).toBe(false);

    // MAX+1-th task is rejected.
    writePendingFile(baseDir, 'over-max-task');
    await (system as any)._enqueueAndDispatch({
      id: 'over-max-task',
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
    } as any);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, 'over-max-task.json'))).toBe(true);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });
});

/**
 * Phase 887: terminalState filtering + overflow notification reliability + corrupt cancel regression.
 */
describe('phase 887', () => {
  function makeAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => events.push([type, ...cols]),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    return { audit, events };
  }

  let baseDir: string;

  function setupBaseDir(): void {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    baseDir = path.join(tmpdir(), `phase887-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(baseDir, { recursive: true });
    for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
      fs.mkdirSync(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
    }
    fs.mkdirSync(path.join(baseDir, 'sync'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'inbox', 'pending'), { recursive: true });
  }

  function writeToolPendingFile(baseDir: string, id: string, extra: Record<string, unknown> = {}): void {
    const p = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${id}.json`);
    fs.writeFileSync(p, JSON.stringify({
      id,
      shortId: id.length === 36 ? id.slice(0, 8) : id,
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
      ...extra,
    }));
  }

  function writeSubagentPendingFile(baseDir: string, id: string, extra: Record<string, unknown> = {}): void {
    const p = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${id}.json`);
    fs.writeFileSync(p, JSON.stringify({
      id,
      kind: 'subagent',
      mode: 'standard',
      shortId: id.slice(0, 8),
      parentClawId: 'parent-claw',
      parentClawDir: baseDir,
      createdAt: new Date().toISOString(),
      timeoutMs: 60000,
      intent: 'test',
      ...extra,
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  });

  it('does not dispatch task with terminalState=failed (notified marker exists)', async () => {
    setupBaseDir();
    const { audit, events } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
    });

    const taskId = '550e8400-e29b-41d4-a716-446655440000';
    writeSubagentPendingFile(baseDir, taskId, { terminalState: 'failed' });
    // notified marker exists
    const resultDir = path.join(baseDir, TASKS_QUEUES_RESULTS_DIR, taskId);
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(path.join(resultDir, 'result.txt.notified'), '');

    const pendingTasks = await (system as any)._getPendingTasks();
    expect(pendingTasks.some((t: { id: string }) => t.id === taskId)).toBe(false);

    // Task should be moved to failed
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${taskId}.json`))).toBe(false);

    // No fallback notification retry because marker exists
    expect(sendFallbackError).not.toHaveBeenCalled();

    const moveFailedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=retry_overflow_move')),
    );
    expect(moveFailedEvents.length).toBe(0);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('retries overflow notification when terminalState=failed and no notified marker', async () => {
    setupBaseDir();
    const { audit, events } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
    });

    const taskId = '550e8400-e29b-41d4-a716-446655440001';
    writeSubagentPendingFile(baseDir, taskId, { terminalState: 'failed' });

    const pendingTasks = await (system as any)._getPendingTasks();
    expect(pendingTasks.some((t: { id: string }) => t.id === taskId)).toBe(false);

    // Notification retried
    expect(sendFallbackError).toHaveBeenCalledTimes(1);
    const callArgs = (sendFallbackError as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[2]).toMatchObject({ id: taskId });
    expect(callArgs[3]).toContain('pending queue overflow');

    // Notified marker written
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_RESULTS_DIR, taskId, 'result.txt.notified'))).toBe(true);

    // Task moved to failed
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${taskId}.json`))).toBe(false);

    const moveFailedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=retry_overflow_move')),
    );
    expect(moveFailedEvents.length).toBe(0);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('keeps task in pending when overflow notification fails, then retries on next cycle', async () => {
    setupBaseDir();
    const { audit, events } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
      pendingQueueMax: 3,
    });

    const taskId = '550e8400-e29b-41d4-a716-446655440003';
    writeToolPendingFile(baseDir, taskId);
    for (let i = 0; i < 3; i++) {
      writeToolPendingFile(baseDir, `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);
    }
    // Ensure queue is at capacity so the overflow task triggers rejection.
    expect(fs.readdirSync(path.join(baseDir, TASKS_QUEUES_PENDING_DIR)).length).toBe(4);

    let callCount = 0;
    (sendFallbackError as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('notify-down');
      }
    });

    // First overflow attempt: notification fails
    await (system as any)._enqueueAndDispatch({
      id: taskId,
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
    } as any);

    // File remains in pending with terminalState='failed'
    const pendingFile = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${taskId}.json`);
    expect(fs.existsSync(pendingFile)).toBe(true);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`))).toBe(false);
    const pendingContent = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
    expect(pendingContent.terminalState).toBe('failed');

    const notifyFailedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cap_overflow_notify_failed')),
    );
    expect(notifyFailedEvents.length).toBe(1);

    // Next dispatch cycle: _getPendingTasks retries notification
    const pendingTasks = await (system as any)._getPendingTasks();
    expect(pendingTasks.some((t: { id: string }) => t.id === taskId)).toBe(false);

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`))).toBe(true);
    expect(fs.existsSync(pendingFile)).toBe(false);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('does not report race-lost when cancel quarantines a corrupt file (backup created during cancel)', async () => {
    setupBaseDir();
    const { audit, events } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
    });

    const taskId = '550e8400-e29b-41d4-a716-446655440002';
    const pendingFile = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${taskId}.json`);
    fs.writeFileSync(pendingFile, 'not valid json');

    await system.cancel(taskId);

    const raceLostEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.TASK_CANCEL_RACE_LOST_TO_DISPATCH,
    );
    expect(raceLostEvents.length).toBe(0);

    const cancelledEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some(c => typeof c === 'string' && c === `fullTaskId=${taskId}`),
    );
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0]).toEqual(
      expect.arrayContaining([expect.stringContaining('from=pending_corrupt')]),
    );

    // Corrupt backup should exist; original pending file should not be moved to failed
    const pendingDir = path.join(baseDir, TASKS_QUEUES_PENDING_DIR);
    const backups = fs.readdirSync(pendingDir).filter(n => n.startsWith(`${taskId}.json.corrupt-`));
    expect(backups.length).toBe(1);
    expect(fs.existsSync(pendingFile)).toBe(false);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`))).toBe(false);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });
});

/**
 * Phase 889:
 * 1. migrated tool recovery: exists/read I/O errors must not be treated as business state
 * 2. migrated tool recovery: SENT_MARKER makes re-delivery idempotent
 * 3. _recoverWithResult: non-ENOENT retry counter read failure stops recovery
 * 4. _recoverWithResult: retry counter write failure stops recovery
 */
describe('phase889.test.ts', () => {
  const VALID_TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
  const VALID_TASK_SHORT_ID = '550e8400';

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

  function makeMigratedToolTask() {
    return {
      kind: 'tool' as const,
      id: VALID_TASK_ID,
      shortId: VALID_TASK_SHORT_ID,
      toolName: 'read',
      args: {},
      parentClawDir: '/tmp',
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 2,
      retryCount: 0,
      mode: 'migrated' as const,
      migratedPid: 12345,
      migratedStartTime: String(Date.now()),
    };
  }

  function makeSubAgentTask() {
    return {
      kind: 'subagent' as const,
      mode: 'standard' as const,
      id: VALID_TASK_ID,
      shortId: VALID_TASK_SHORT_ID,
      intent: 'test',
      timeoutMs: 1000,
      maxSteps: 1,
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
    };
  }

  function makeMockFs(
    runningFiles: Array<{ name: string; path: string; content: string }>,
    overrides?: {
      exists?: (path: string, fileMap: Map<string, string>) => Promise<boolean> | boolean;
      read?: (path: string, fileMap: Map<string, string>) => Promise<string>;
      writeAtomic?: (path: string, content: string, fileMap: Map<string, string>) => Promise<void>;
    },
  ): FileSystem {
    const fileMap = new Map<string, string>();
    for (const f of runningFiles) fileMap.set(f.path, f.content);

    return {
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir === 'tasks/queues/running') {
          return Promise.resolve(runningFiles.map((f) => ({ name: f.name, path: f.path })));
        }
        if (dir === 'tasks/queues/pending') return Promise.resolve([]);
        if (dir === 'tasks/queues/failed') return Promise.resolve([]);
        return Promise.resolve([]);
      }),
      read: vi.fn().mockImplementation((path: string) => {
        if (overrides?.read) return overrides.read(path, fileMap);
        const content = fileMap.get(path);
        if (content === undefined) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          return Promise.reject(err);
        }
        return Promise.resolve(content);
      }),
      move: vi.fn().mockImplementation((from: string, to: string) => {
        const content = fileMap.get(from);
        fileMap.delete(from);
        if (content !== undefined) fileMap.set(to, content);
        return Promise.resolve(undefined);
      }),
      delete: vi.fn().mockImplementation((path: string) => {
        fileMap.delete(path);
        return Promise.resolve(undefined);
      }),
      writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
        if (overrides?.writeAtomic) return overrides.writeAtomic(path, content, fileMap);
        fileMap.set(path, content);
        return Promise.resolve(undefined);
      }),
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation((path: string) => {
        if (overrides?.exists) return overrides.exists(path, fileMap);
        return Promise.resolve(fileMap.has(path));
      }),
    } as unknown as FileSystem;
  }

  describe('phase 889: migrated tool recovery I/O error handling', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('keeps task in running when result exists() throws I/O error', async () => {
      const task = makeMigratedToolTask();
      const taskFile = 'tasks/queues/running/task-1.json';
      const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
      const mockFs = makeMockFs(
        [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
        {
          exists: vi.fn().mockImplementation((path: string, fileMap: Map<string, string>) => {
            if (path === resultPath) {
              const err = new Error('EIO') as NodeJS.ErrnoException;
              err.code = 'EIO';
              return Promise.reject(err);
            }
            return Promise.resolve(fileMap.has(path));
          }),
        },
      );
      const { audit, events } = makeMockAudit();

      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      expect(mockFs.move).not.toHaveBeenCalled();
      expect(sendToolResult).not.toHaveBeenCalled();
      expect(await mockFs.exists(taskFile)).toBe(true);

      const failedEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
          (col) => typeof col === 'string' && col.includes('context=migrated_result_exists_io_error'),
        ),
      );
      expect(failedEvents.length).toBe(1);
    });

    it('keeps task in running when result read() throws I/O error', async () => {
      const task = makeMigratedToolTask();
      const taskFile = 'tasks/queues/running/task-1.json';
      const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
      const mockFs = makeMockFs(
        [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
        {
          read: vi.fn().mockImplementation((path: string, fileMap: Map<string, string>) => {
            if (path === resultPath) {
              const err = new Error('EIO') as NodeJS.ErrnoException;
              err.code = 'EIO';
              return Promise.reject(err);
            }
            const content = fileMap.get(path);
            if (content === undefined) {
              const err = new Error('ENOENT') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              return Promise.reject(err);
            }
            return Promise.resolve(content);
          }),
        },
      );
      // Pre-populate result file so exists() returns true.
      await mockFs.writeAtomic(resultPath, 'output');
      const { audit, events } = makeMockAudit();

      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      expect(sendToolResult).not.toHaveBeenCalled();
      expect(await mockFs.exists(taskFile)).toBe(true);

      const failedEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
          (col) => typeof col === 'string' && col.includes('context=migrated_result_read_io_error'),
        ),
      );
      expect(failedEvents.length).toBe(1);
    });

    it('skips re-delivery when sent marker exists and moves to done', async () => {
      const task = makeMigratedToolTask();
      const taskFile = 'tasks/queues/running/task-1.json';
      const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
      const sentMarkerPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt.sent`;

      const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
      await mockFs.writeAtomic(resultPath, 'output');
      await mockFs.writeAtomic(sentMarkerPath, '1');

      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      expect(sendToolResult).not.toHaveBeenCalled();
      expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);

      const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
      expect(recoveredEvents.length).toBe(1);
      expect(recoveredEvents[0]).toContain('reason=migrated_sent_marker_found');
    });
  });

  describe('phase 889: retry counter I/O errors stop recovery', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('stops recovery when retry counter read fails with non-ENOENT error', async () => {
      const task = makeSubAgentTask();
      const taskFile = 'tasks/queues/running/task-1.json';
      const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
      const retryPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt.retry-count`;

      const mockFs = makeMockFs(
        [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
        {
          read: vi.fn().mockImplementation((path: string, fileMap: Map<string, string>) => {
            if (path === retryPath) {
              const err = new Error('EACCES') as NodeJS.ErrnoException;
              err.code = 'EACCES';
              return Promise.reject(err);
            }
            const content = fileMap.get(path);
            if (content === undefined) {
              const err = new Error('ENOENT') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              return Promise.reject(err);
            }
            return Promise.resolve(content);
          }),
        },
      );
      await mockFs.writeAtomic(resultPath, 'result content');

      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      expect(sendResult).not.toHaveBeenCalled();
      expect(await mockFs.exists(taskFile)).toBe(true);

      const failedEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
          (col) => typeof col === 'string' && col.includes('context=retry_counter_read_failed'),
        ),
      );
      expect(failedEvents.length).toBe(1);
    });

    it('stops recovery when retry counter write fails', async () => {
      const task = makeSubAgentTask();
      const taskFile = 'tasks/queues/running/task-1.json';
      const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
      const retryPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt.retry-count`;

      vi.mocked(sendResult).mockRejectedValueOnce(new Error('delivery failed'));
      vi.mocked(sendFallbackError).mockRejectedValueOnce(new Error('fallback fail'));

      const mockFs = makeMockFs(
        [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
        {
          writeAtomic: vi.fn().mockImplementation((path: string, content: string, fileMap: Map<string, string>) => {
            if (path === retryPath) {
              const err = new Error('disk full') as NodeJS.ErrnoException;
              err.code = 'ENOSPC';
              return Promise.reject(err);
            }
            fileMap.set(path, content);
            return Promise.resolve(undefined);
          }),
        },
      );
      await mockFs.writeAtomic(resultPath, 'result content');

      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      expect(sendResult).toHaveBeenCalledTimes(1);
      expect(await mockFs.exists(taskFile)).toBe(true);
      expect(await mockFs.exists(retryPath)).toBe(false);

      const failedEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
          (col) => typeof col === 'string' && col.includes('context=retry_counter_persist_failed'),
        ),
      );
      expect(failedEvents.length).toBe(1);
    });
  });
});

/**
 * Phase 902: overflow terminalState propagation + marker I/O + load/rebuild fullId conflict.
 */
describe('phase 902', () => {
  function makeAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => events.push([type, ...cols]),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    return { audit, events };
  }

  let baseDir: string;

  function setupBaseDir(): void {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    baseDir = path.join(tmpdir(), `phase902-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(baseDir, { recursive: true });
    for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
      fs.mkdirSync(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
    }
    fs.mkdirSync(path.join(baseDir, 'sync'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'inbox', 'pending'), { recursive: true });
  }

  function writeToolPendingFile(baseDir: string, id: string, extra: Record<string, unknown> = {}): void {
    const p = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${id}.json`);
    fs.writeFileSync(p, JSON.stringify({
      id,
      shortId: id.length === 36 ? id.slice(0, 8) : id,
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
      ...extra,
    }));
  }

  function writeSubagentPendingFile(baseDir: string, id: string, extra: Record<string, unknown> = {}): void {
    const p = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${id}.json`);
    fs.writeFileSync(p, JSON.stringify({
      id,
      kind: 'subagent',
      mode: 'standard',
      shortId: id.slice(0, 8),
      parentClawId: 'parent-claw',
      parentClawDir: baseDir,
      createdAt: new Date().toISOString(),
      timeoutMs: 60000,
      intent: 'test',
      ...extra,
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  });

  it('propagates terminalState write failure during overflow and keeps task in pending', async () => {
    setupBaseDir();
    const { audit, events } = makeAudit();

    const taskId = '550e8400-e29b-41d4-a716-446655440000';
    writeSubagentPendingFile(baseDir, taskId);
    for (let i = 0; i < 3; i++) {
      writeToolPendingFile(baseDir, `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);
    }

    const { NodeFileSystem } = await import('../../../src/foundation/fs/node-fs.js');
    const realFs = new NodeFileSystem({ baseDir });

    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      pendingQueueMax: 3,
      ...makeTaskSystemDeps(),
    });

    vi.spyOn(system as any, '_setTerminalState').mockRejectedValue(new Error('terminal-state-disk-full'));

    await expect(
      (system as any)._enqueueAndDispatch({
        id: taskId,
        kind: 'subagent',
        mode: 'standard',
        parentClawId: 'parent-claw',
        parentClawDir: baseDir,
        intent: 'test',
      } as any),
    ).rejects.toThrow('terminal-state-disk-full');

    // Task must remain in pending — cannot move to failed without terminalState.
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${taskId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`))).toBe(false);

    // Notification must not be attempted once terminalState fails.
    expect(sendFallbackError).not.toHaveBeenCalled();

    const terminalStateFailedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cap_overflow_terminal_state_failed')),
    );
    expect(terminalStateFailedEvents.length).toBe(1);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('does not re-send notification when overflow marker read fails with IO error', async () => {
    setupBaseDir();
    const { audit, events } = makeAudit();

    const taskId = '550e8400-e29b-41d4-a716-446655440001';
    writeSubagentPendingFile(baseDir, taskId, { terminalState: 'failed' });

    const { NodeFileSystem } = await import('../../../src/foundation/fs/node-fs.js');
    const realFs = new NodeFileSystem({ baseDir });
    const originalExists = realFs.exists.bind(realFs);
    const fsExists = vi.spyOn(realFs, 'exists').mockImplementation(async (p: string) => {
      if (p.includes(`${taskId}/result.txt.notified`)) {
        const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
        throw err;
      }
      return originalExists(p);
    });

    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });

    const pendingTasks = await (system as any)._getPendingTasks();
    expect(pendingTasks.some((t: { id: string }) => t.id === taskId)).toBe(false);

    // Must NOT retry notification when marker state is unknown.
    expect(sendFallbackError).not.toHaveBeenCalled();

    // Task must stay in pending for next cycle retry.
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${taskId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`))).toBe(false);

    const markerReadFailedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=overflow_marker_read_failed')),
    );
    expect(markerReadFailedEvents.length).toBe(1);

    fsExists.mockRestore();
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('sets needsRebuild and emits audit when load detects fullId conflict', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'phase902-short-id-index-'));
    try {
    fs.mkdirSync(path.join(tmpDir, 'tasks', 'queues'), { recursive: true });

    const fullId = '550e8400-e29b-41d4-a716-446655440000';
    fs.writeFileSync(
      path.join(tmpDir, 'tasks', 'queues', 'short-id-map.json'),
      JSON.stringify({
        abcdef12: fullId,
        fedcba98: fullId,
      }),
    );

    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const auditWriter = { write: (event: string, payload: Record<string, unknown>) => events.push({ event, payload }) };

    const { NodeFileSystem } = await import('../../../src/foundation/fs/node-fs.js');
    const fsImpl = new NodeFileSystem({ baseDir: tmpDir });
    const index = new PersistentShortIdIndex(fsImpl);
    index.load(auditWriter);

    expect(index.needsRebuild).toBe(true);
    const failedEvent = events.find(e => e.event === TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED);
    expect(failedEvent).toBeDefined();
    expect(String(failedEvent?.payload.error)).toContain('already mapped');
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
    }
  });
});

