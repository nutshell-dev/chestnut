/**
 * phase 7: pending queue overflow dedup — 同 overflow 窗口仅 1 通知.
 * queue 降回 cap 以下后清 0、允许下次 overflow 再发.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { PENDING_QUEUE_MAX } from '../../../src/core/async-task-system/constants.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/dirs.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { InboxWriter } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

function makeAudit(): { audit: AuditLog } {
  return { audit: { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} };
}

function setupBaseDir(): string {
  const baseDir = path.join(tmpdir(), `test-overflow-dedup-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(baseDir, { recursive: true });
  for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
    fs.mkdirSync(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
  }
  fs.mkdirSync(path.join(baseDir, 'sync'), { recursive: true });
  fs.mkdirSync(path.join(baseDir, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(baseDir, 'inbox', 'pending'), { recursive: true });
  return baseDir;
}

function writePendingFile(baseDir: string, id: string): void {
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
  }));
}

function clearPendingDir(baseDir: string): void {
  const dir = path.join(baseDir, TASKS_QUEUES_PENDING_DIR);
  for (const f of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, f));
  }
}

describe('phase 7: overflow dedup (system-level overload, 1 notif per window)', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = setupBaseDir(); });

  it('multiple overflow rejections within same window → 1 motion notification', async () => {
    const { audit } = makeAudit();
    const inboxWrites: Array<Record<string, unknown>> = [];
    const mockInbox: InboxWriter = {
      writeSync: vi.fn((msg) => { inboxWrites.push(msg as Record<string, unknown>); }),
    } as unknown as InboxWriter;

    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit, llm: {} as any, contractManager: {} as any,
      outboxWriter: {} as any, registry: {} as any, selfInbox: mockInbox,
    });

    for (let i = 0; i < PENDING_QUEUE_MAX; i++) {
      writePendingFile(baseDir, `task-${i}`);
    }

    // Phase 886: each overflow task must exist in pending so the move to failed succeeds.
    for (let i = 0; i < 3; i++) {
      writePendingFile(baseDir, `overflow-${i}`);
    }

    // Trigger 3 overflow rejections in same window
    for (let i = 0; i < 3; i++) {
      await (system as any)._enqueueAndDispatch({ id: `overflow-${i}`, kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);
    }

    // Only 1 notification despite 3 rejections (dedup)
    const overflowMsgs = inboxWrites.filter(w => w.type === 'task_queue_overflow');
    expect(overflowMsgs.length).toBe(1);
  });

  it('new body framing — system-level (not per-task) + capacity number', async () => {
    const { audit } = makeAudit();
    const inboxWrites: Array<Record<string, unknown>> = [];
    const mockInbox: InboxWriter = {
      writeSync: vi.fn((msg) => { inboxWrites.push(msg as Record<string, unknown>); }),
    } as unknown as InboxWriter;

    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit, llm: {} as any, contractManager: {} as any,
      outboxWriter: {} as any, registry: {} as any, selfInbox: mockInbox,
    });

    writePendingFile(baseDir, 'overflow-task');
    for (let i = 0; i < PENDING_QUEUE_MAX; i++) {
      writePendingFile(baseDir, `task-${i}`);
    }

    await (system as any)._enqueueAndDispatch({ id: 'overflow-task', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);

    const msg = inboxWrites.find(w => w.type === 'task_queue_overflow');
    expect(msg).toBeDefined();
    expect(msg!.body).toContain(`at capacity (${PENDING_QUEUE_MAX} pending)`);
    expect(msg!.body).toContain('chronic processing failure');
    // 新 body 不应再含 per-task framing (`Task <id> rejected`)
    expect(msg!.body as string).not.toMatch(/Task \S+ (rejected|\(\w+\))/);
    // extraFields 透传 cap + queue_length 给 composer
    expect((msg!.extraFields as Record<string, string>).cap).toBe(String(PENDING_QUEUE_MAX));
  });

  it('after queue drains below cap, dedup resets — next overflow re-notifies', async () => {
    const { audit } = makeAudit();
    const inboxWrites: Array<Record<string, unknown>> = [];
    const mockInbox: InboxWriter = {
      writeSync: vi.fn((msg) => { inboxWrites.push(msg as Record<string, unknown>); }),
    } as unknown as InboxWriter;

    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit, llm: {} as any, contractManager: {} as any,
      outboxWriter: {} as any, registry: {} as any, selfInbox: mockInbox,
    });

    // First overflow window
    writePendingFile(baseDir, 'first-overflow');
    for (let i = 0; i < PENDING_QUEUE_MAX; i++) {
      writePendingFile(baseDir, `task-${i}`);
    }
    await (system as any)._enqueueAndDispatch({ id: 'first-overflow', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);
    expect(inboxWrites.filter(w => w.type === 'task_queue_overflow').length).toBe(1);

    // Drain queue (simulate processing)
    clearPendingDir(baseDir);

    // _enqueueAndDispatch 不在 overflow case 时也会 reset dedup
    await (system as any)._enqueueAndDispatch({ id: 'recovery-task', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any).catch(() => { /* silent: cleanup */ });

    // Re-fill queue + second overflow
    writePendingFile(baseDir, 'second-overflow');
    for (let i = 0; i < PENDING_QUEUE_MAX; i++) {
      writePendingFile(baseDir, `task2-${i}`);
    }
    await (system as any)._enqueueAndDispatch({ id: 'second-overflow', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);

    // 2 notifications now (across 2 windows)
    expect(inboxWrites.filter(w => w.type === 'task_queue_overflow').length).toBe(2);
  });
});
