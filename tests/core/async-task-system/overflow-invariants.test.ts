/**
 * Merged test file (mechanical consolidation, no assertion changes).
 * Sources:
 *  - pending-queue-overflow-notify.test.ts
 *  - pending-queue-overflow-dedup.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import type { AsyncTaskSystemOptions } from '../../../src/core/async-task-system/system.js';
import { PENDING_QUEUE_MAX } from '../../../src/core/async-task-system/constants.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../../src/core/async-task-system/dirs.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { InboxWriter } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('pending queue overflow motion notify', () => {
  function makeMockAudit(): { audit: AuditLog; writes: Array<{ type: string; cols: string[] }> } {
    const writes: Array<{ type: string; cols: string[] }> = [];
    return {
      audit: { write: (type: string, ...cols: (string | number)[]) => writes.push({ type, cols: cols.map(String) }) , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s},
      writes,
    };
  }

  let baseDir: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    baseDir = path.join(tmpdir(), `test-overflow-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(baseDir, { recursive: true });
    // create queues dirs (match TASKS_QUEUES_*_DIR = 'tasks/queues/...')
    for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
      fs.mkdirSync(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
    }
    fs.mkdirSync(path.join(baseDir, 'sync'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, 'inbox', 'pending'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  });

  function writePendingFile(id: string): void {
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

  it('反向 1: overflow 触发 -> selfInbox.writeSync called + audit PENDING_QUEUE_OVERFLOW_NOTIFIED + file moved to failed', async () => {
    const { audit, writes } = makeMockAudit();
    const inboxWrites: Array<Record<string, unknown>> = [];
    const mockInbox: InboxWriter = {
      writeSync: vi.fn((msg) => { inboxWrites.push(msg as Record<string, unknown>); }),
    } as unknown as InboxWriter;

    const realFs = new NodeFileSystem({ baseDir });

    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      registry: {} as any,
      selfInbox: mockInbox,
      pendingQueueMax: 3,
    });

    // Phase 886: need MAX+1 pending tasks to trigger overflow (cap is now > MAX).
    // The overflow task itself must exist in pending so the move to failed succeeds.
    writePendingFile('overflow-task');
    for (let i = 0; i < 3; i++) {
      writePendingFile(`task-${i}`);
    }

    // 触发 overflow
    await (system as any)._enqueueAndDispatch({ id: 'overflow-task', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);

    // 验收 1: selfInbox.writeSync called
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

  it('反向 2: selfInbox 未传 -> 保持既有行为 (0 writeSync, 0 audit NOTIFIED, 0 throw, audit OVERFLOW still emitted)', async () => {
    const { audit, writes } = makeMockAudit();

    const realFs = new NodeFileSystem({ baseDir });

    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      registry: {} as any,
      pendingQueueMax: 3,
      // 不传 selfInbox
    });

    writePendingFile('no-inbox-task');
    for (let i = 0; i < 3; i++) {
      writePendingFile(`task-${i}`);
    }

    await (system as any)._enqueueAndDispatch({ id: 'no-inbox-task', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);

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
    fs.writeFileSync(taskFile, JSON.stringify({
      id: taskId,
      kind: 'subagent',
      mode: 'standard',
      shortId: taskId.slice(0, 8),
      parentClawId: 'parent-claw',
      parentClawDir: baseDir,
      createdAt: new Date().toISOString(),
      timeoutMs: 60000,
      intent: 'test',
    }));

    const realFs = new NodeFileSystem({ baseDir });

    const mockInbox: InboxWriter = {
      writeSync: vi.fn(),
    } as unknown as InboxWriter;

    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as any,
      contractManager: {} as any,
      registry: {} as any,
      selfInbox: mockInbox,
      pendingQueueMax: 3,
    });

    for (let i = 0; i < 3; i++) {
      writePendingFile(`task-${i}`);
    }

    await (system as any)._enqueueAndDispatch({ id: taskId, kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);

    // 验收: task file 从 pending 移到了 failed
    const failedFile = path.join(failedDir, `${taskId}.json`);
    expect(fs.existsSync(failedFile)).toBe(true);
    // 验收: pending file 已移走
    expect(fs.existsSync(taskFile)).toBe(false);
  });

  it('phase 1836: 失败前置（失败结果投递失败）→ 系统通知零投递，不宣称已处理', async () => {
    const { audit } = makeMockAudit();
    const inboxWrites: Array<Record<string, unknown>> = [];
    const mockInbox: InboxWriter = {
      writeSync: vi.fn((msg) => { inboxWrites.push(msg as Record<string, unknown>); }),
    } as unknown as InboxWriter;

    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit, llm: {} as any, contractManager: {} as any,
      registry: {} as any, selfInbox: mockInbox,
      pendingQueueMax: 3,
      // 故障注入：sendFallbackResult 失败 → notified marker 不写 → 任务留 pending 重试
      sendFallbackResult: async () => { throw new Error('inbox unavailable'); },
    });

    writePendingFile('overflow-task');
    for (let i = 0; i < 3; i++) {
      writePendingFile(`task-${i}`);
    }

    await (system as any)._enqueueAndDispatch({ id: 'overflow-task', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);

    // 验收：本轮系统通知零投递——结果未成功投递时不得发送宣称“已投递失败结果”的通知
    expect(inboxWrites.filter(w => w.type === 'task_queue_overflow')).toHaveLength(0);
    // 任务未搬 failed（留 pending 供下轮 _retryOverflowMove 恢复）
    expect(fs.existsSync(path.join(baseDir, 'tasks', 'queues', 'pending', 'overflow-task.json'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'tasks', 'queues', 'failed', 'overflow-task.json'))).toBe(false);
  });
});

/**
 * phase 7: pending queue overflow dedup — 同 overflow 窗口仅 1 通知.
 * queue 降回 cap 以下后清 0、允许下次 overflow 再发.
 */

describe('phase 7: overflow dedup (system-level overload, 1 notif per window)', () => {
  function makeAudit(): { audit: AuditLog } {
    return { audit: { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} };
  }

  function setupBaseDir(): string {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
      try { fs.unlinkSync(path.join(dir, f)); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    }
  }

  let baseDir: string;
  beforeEach(() => { baseDir = setupBaseDir(); });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  });

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
      registry: {} as any, selfInbox: mockInbox,
      pendingQueueMax: 3,
    });

    // Phase 886: each overflow task must exist in pending so the move to failed succeeds.
    for (let i = 0; i < 3; i++) {
      writePendingFile(baseDir, `task-${i}`);
    }
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

  it('phase 1836: body 准确说明单次拒绝 — 实际任务 ID、拒绝前观测 count=4/cap=3、已执行处置', async () => {
    const { audit } = makeAudit();
    const inboxWrites: Array<Record<string, unknown>> = [];
    const mockInbox: InboxWriter = {
      writeSync: vi.fn((msg) => { inboxWrites.push(msg as Record<string, unknown>); }),
    } as unknown as InboxWriter;

    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit, llm: {} as any, contractManager: {} as any,
      registry: {} as any, selfInbox: mockInbox,
      pendingQueueMax: 3,
    });

    writePendingFile(baseDir, 'overflow-task');
    for (let i = 0; i < 3; i++) {
      writePendingFile(baseDir, `task-${i}`);
    }

    await (system as any)._enqueueAndDispatch({ id: 'overflow-task', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);

    const msg = inboxWrites.find(w => w.type === 'task_queue_overflow');
    expect(msg).toBeDefined();
    // 精确新正文：本次被拒任务 fullId + 拒绝处置前观测 4（含本任务）/上限 3 + 系统已执行处置
    expect(msg!.body).toBe([
      '一次异步任务提交因待处理队列超限被拒绝。',
      '任务：overflow-task',
      '检查时队列数量：4；上限：3',
      '',
      '系统已将该任务记为失败，并另行投递失败结果。',
      '上述数量是拒绝发生前的观测值，收到通知时队列状态可能已经变化。',
    ].join('\n'));
    // 旧语义不回退：cap 不是观测值、无长期故障推断、无 system-level framing
    expect(msg!.body as string).not.toContain('at capacity');
    expect(msg!.body as string).not.toContain('chronic');
    expect(msg!.body as string).not.toContain('system-level');
    // extraFields 透传 cap + queue_length 保持
    expect((msg!.extraFields as Record<string, string>).cap).toBe('3');
    expect((msg!.extraFields as Record<string, string>).queue_length).toBe('4');
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
      registry: {} as any, selfInbox: mockInbox,
      pendingQueueMax: 3,
    });

    // First overflow window
    writePendingFile(baseDir, 'first-overflow');
    for (let i = 0; i < 3; i++) {
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
    for (let i = 0; i < 3; i++) {
      writePendingFile(baseDir, `task2-${i}`);
    }
    await (system as any)._enqueueAndDispatch({ id: 'second-overflow', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir } as any);

    // 2 notifications now (across 2 windows)
    expect(inboxWrites.filter(w => w.type === 'task_queue_overflow').length).toBe(2);
  });

  it('default pendingQueueMax falls back to PENDING_QUEUE_MAX (1000)', async () => {
    const { audit } = makeAudit();
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit, llm: {} as any, contractManager: {} as any,
      registry: {} as any,
    });
    expect((system as any).pendingQueueMax).toBe(PENDING_QUEUE_MAX);
  });
});
