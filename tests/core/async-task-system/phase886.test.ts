/**
 * Phase 886: overflow parent notification + move propagation + corrupt cancel + cap boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
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

describe('phase 886', () => {
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
