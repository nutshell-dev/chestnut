/**
 * Phase 886: overflow parent notification + move propagation + corrupt cancel + cap boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { PENDING_QUEUE_MAX } from '../../../src/core/async-task-system/constants.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_FAILED_DIR } from '../../../src/core/async-task-system/dirs.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendFallbackError: vi.fn().mockResolvedValue(undefined),
}));

import { sendFallbackError } from '../../../src/core/async-task-system/result-delivery.js';

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

function setupBaseDir(): string {
  const baseDir = path.join(tmpdir(), `phase886-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(baseDir, { recursive: true });
  for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
    fs.mkdirSync(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
  }
  fs.mkdirSync(path.join(baseDir, 'sync'), { recursive: true });
  fs.mkdirSync(path.join(baseDir, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(baseDir, 'inbox', 'pending'), { recursive: true });
  return baseDir;
}

function writePendingFile(baseDir: string, id: string, extra: Record<string, unknown> = {}): void {
  const p = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({
    id,
    kind: 'tool',
    toolName: 'test',
    args: {},
    parentClawDir: baseDir,
    parentClawId: 'parent-claw',
    createdAt: new Date().toISOString(),
    ...extra,
  }));
}

describe('phase 886', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends fallback error to parent on overflow', async () => {
    const baseDir = setupBaseDir();
    const { audit } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
    });

    writePendingFile(baseDir, 'overflow-task');
    for (let i = 0; i < PENDING_QUEUE_MAX; i++) {
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

  it('throws and re-signals when overflow move fails', async () => {
    const baseDir = setupBaseDir();
    const { audit, events } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });

    let signalCount = 0;
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
    });
    const originalSignal = (system as any)._signalWork.bind(system);
    (system as any)._signalWork = () => {
      signalCount++;
      originalSignal();
    };

    // Replace move with one that rejects for the overflow path only.
    const originalMove = realFs.move.bind(realFs);
    realFs.move = async (from: string, to: string) => {
      if (from.includes('tasks/queues/pending/overflow-task.json')) {
        const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
        throw err;
      }
      return originalMove(from, to);
    };

    writePendingFile(baseDir, 'overflow-task');
    for (let i = 0; i < PENDING_QUEUE_MAX; i++) {
      writePendingFile(baseDir, `task-${i}`);
    }

    await expect((system as any)._enqueueAndDispatch({
      id: 'overflow-task',
      kind: 'tool',
      toolName: 'test',
      args: {},
      parentClawDir: baseDir,
      parentClawId: 'parent-claw',
    } as any)).rejects.toThrow('EACCES');

    expect(signalCount).toBeGreaterThanOrEqual(1);

    const moveFailedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cap_overflow_move')),
    );
    expect(moveFailedEvents.length).toBe(1);

    // Task file must remain in pending so the dispatcher can retry.
    const pendingFile = path.join(baseDir, TASKS_QUEUES_PENDING_DIR, 'overflow-task.json');
    expect(fs.existsSync(pendingFile)).toBe(true);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('does not report race-lost when task was backed up as corrupt', async () => {
    const baseDir = setupBaseDir();
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
    const baseDir = setupBaseDir();
    const { audit } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
    });

    // Fill to MAX-1.
    for (let i = 0; i < PENDING_QUEUE_MAX - 1; i++) {
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
