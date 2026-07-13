/**
 * Phase 887: terminalState filtering + overflow notification reliability + corrupt cancel regression.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { PENDING_QUEUE_MAX } from '../../../src/core/async-task-system/constants.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_FAILED_DIR, TASKS_QUEUES_RESULTS_DIR } from '../../../src/core/async-task-system/dirs.js';
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

describe('phase 887', () => {
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
    });

    const taskId = '550e8400-e29b-41d4-a716-446655440003';
    writeToolPendingFile(baseDir, taskId);
    for (let i = 0; i < PENDING_QUEUE_MAX; i++) {
      writeToolPendingFile(baseDir, `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);
    }
    // Ensure queue is at capacity so the overflow task triggers rejection.
    expect(fs.readdirSync(path.join(baseDir, TASKS_QUEUES_PENDING_DIR)).length).toBe(PENDING_QUEUE_MAX + 1);

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
