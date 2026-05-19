import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import type { AsyncTaskSystemOptions } from '../../../src/core/async-task-system/system.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { InboxWriter } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

function makeMockAudit(): { audit: AuditLog; writes: Array<{ type: string; cols: string[] }> } {
  const writes: Array<{ type: string; cols: string[] }> = [];
  return {
    audit: { write: (type: string, ...cols: (string | number)[]) => writes.push({ type, cols: cols.map(String) }) },
    writes,
  };
}

describe('pending queue overflow motion notify', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = path.join(tmpdir(), `test-overflow-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(baseDir, { recursive: true });
    // create queues dirs (match TASKS_QUEUES_*_DIR = 'tasks/queues/...')
    for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
      fs.mkdirSync(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
    }
    fs.mkdirSync(path.join(baseDir, 'sync'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'subagents'), { recursive: true });
  });

  it('反向 1: overflow 触发 -> motionInbox.writeSync called + audit PENDING_QUEUE_OVERFLOW_NOTIFIED + file moved to failed', async () => {
    const { audit, writes } = makeMockAudit();
    const inboxWrites: Array<Record<string, unknown>> = [];
    const mockInbox: InboxWriter = {
      writeSync: vi.fn((msg) => { inboxWrites.push(msg as Record<string, unknown>); }),
    } as unknown as InboxWriter;

    const realFs = new NodeFileSystem({ baseDir });

    const system = new AsyncTaskSystem(baseDir, realFs, {
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
      motionInbox: mockInbox,
    });

    // 塞满 pendingQueue 到 PENDING_QUEUE_MAX
    const pendingQueue = (system as any).pendingQueue as any[];
    for (let i = 0; i < 1000; i++) {
      pendingQueue.push({ id: `task-${i}`, kind: 'subagent' });
    }

    // 触发 overflow
    await (system as any)._enqueueAndDispatch({ id: 'overflow-task', kind: 'subagent' } as any);

    // 验收 1: motionInbox.writeSync called
    expect(inboxWrites.length).toBeGreaterThanOrEqual(1);
    const msg = inboxWrites.find(w => w.type === 'task_queue_overflow');
    expect(msg).toBeDefined();
    expect(msg!.priority).toBe('critical');

    // 验收 2: audit PENDING_QUEUE_OVERFLOW (既有) + PENDING_QUEUE_OVERFLOW_NOTIFIED (new)
    const overflowAudit = writes.find(w => w.type === TASK_AUDIT_EVENTS.PENDING_QUEUE_OVERFLOW);
    expect(overflowAudit).toBeDefined();
    const notifiedAudit = writes.find(w => w.type === TASK_AUDIT_EVENTS.PENDING_QUEUE_OVERFLOW_NOTIFIED);
    expect(notifiedAudit).toBeDefined();
  });

  it('反向 2: motionInbox 未传 -> 保持既有行为 (0 writeSync, 0 audit NOTIFIED, 0 throw, audit OVERFLOW still emitted)', async () => {
    const { audit, writes } = makeMockAudit();

    const realFs = new NodeFileSystem({ baseDir });

    const system = new AsyncTaskSystem(baseDir, realFs, {
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
      // 不传 motionInbox
    });

    const pendingQueue = (system as any).pendingQueue as any[];
    for (let i = 0; i < 1000; i++) {
      pendingQueue.push({ id: `task-${i}`, kind: 'subagent' });
    }

    await (system as any)._enqueueAndDispatch({ id: 'no-inbox-task', kind: 'subagent' } as any);

    // 验收: PENDING_QUEUE_OVERFLOW 仍 emit
    const overflowAudit = writes.find(w => w.type === TASK_AUDIT_EVENTS.PENDING_QUEUE_OVERFLOW);
    expect(overflowAudit).toBeDefined();
    // PENDING_QUEUE_OVERFLOW_NOTIFIED 不 emit
    const notifiedAudit = writes.find(w => w.type === TASK_AUDIT_EVENTS.PENDING_QUEUE_OVERFLOW_NOTIFIED);
    expect(notifiedAudit).toBeUndefined();
  });

  it('反向 3: task file moved to failed/ on overflow', async () => {
    const { audit } = makeMockAudit();

    // 创建一个真实 task file 在 pending dir
    const taskId = 'test-overflow-task';
    const pendingDir = path.join(baseDir, 'tasks', 'queues', 'pending');
    const failedDir = path.join(baseDir, 'tasks', 'queues', 'failed');
    const taskFile = path.join(pendingDir, `${taskId}.json`);
    fs.writeFileSync(taskFile, JSON.stringify({ id: taskId, kind: 'subagent' }));

    const realFs = new NodeFileSystem({ baseDir });

    const mockInbox: InboxWriter = {
      writeSync: vi.fn(),
    } as unknown as InboxWriter;

    const system = new AsyncTaskSystem(baseDir, realFs, {
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      outboxWriter: {} as any,
      registry: {} as any,
      motionInbox: mockInbox,
    });

    const pendingQueue = (system as any).pendingQueue as any[];
    for (let i = 0; i < 1000; i++) {
      pendingQueue.push({ id: `task-${i}`, kind: 'subagent' });
    }

    await (system as any)._enqueueAndDispatch({ id: taskId, kind: 'subagent' } as any);

    // 验收: task file 从 pending 移到了 failed
    const failedFile = path.join(failedDir, `${taskId}.json`);
    expect(fs.existsSync(failedFile)).toBe(true);
    // 验收: pending file 已移走
    expect(fs.existsSync(taskFile)).toBe(false);
  });
});
