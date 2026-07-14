/**
 * Phase 902: overflow terminalState propagation + marker I/O + load/rebuild fullId conflict.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_FAILED_DIR, TASKS_QUEUES_RESULTS_DIR } from '../../../src/core/async-task-system/dirs.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendFallbackError: vi.fn().mockResolvedValue(undefined),
}));

import { sendFallbackError } from '../../../src/core/async-task-system/result-delivery.js';
import { PersistentShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';

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

describe('phase 902', () => {
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
