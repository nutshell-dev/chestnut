import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex, PersistentShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR } from '../../../src/core/async-task-system/dirs.js';
import { makeFullTaskId, makeShortTaskId } from '../../../src/core/async-task-system/types.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeAudit(): AuditLog {
  return {
    write: () => { /* no-op */ },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
}

function makeSystem(clawDir: string) {
  const fs = new NodeFileSystem({ baseDir: clawDir });
  return new AsyncTaskSystem(clawDir, fs, {
    auditWriter: makeAudit(),
    shortIdIndex: new InMemoryShortIdIndex(),
    ...makeTaskSystemDeps(),
  });
}

function legacyToolTask(id: string): Record<string, unknown> {
  return {
    kind: 'tool',
    id,
    toolName: 'exec',
    args: { command: 'echo hello' },
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: true,
    maxRetries: 2,
    retryCount: 0,
  };
}

function malformedTask(): Record<string, unknown> {
  // 缺少 id 字段，会进入 malformed 分支
  return {
    kind: 'tool',
    toolName: 'exec',
    args: { command: 'echo hello' },
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 2,
    retryCount: 0,
  };
}

function captureAudit(): { writer: AuditLog; events: Array<{ type: string; cols: (string | number)[] }> } {
  const events: Array<{ type: string; cols: (string | number)[] }> = [];
  return {
    events,
    writer: {
      write: (type, ...cols) => events.push({ type, cols }),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    },
  };
}

describe('Phase 868 legacy task file migration', () => {
  let tmpDir: string;
  let clawDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase868-migration-'));
    clawDir = path.join(tmpDir, 'claw');
    fs.mkdirSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR), { recursive: true });
    fs.mkdirSync(path.join(clawDir, TASKS_QUEUES_RUNNING_DIR), { recursive: true });
    fs.mkdirSync(path.join(clawDir, TASKS_QUEUES_DONE_DIR), { recursive: true });
    fs.mkdirSync(path.join(clawDir, TASKS_QUEUES_FAILED_DIR), { recursive: true });
  });

  it('migrates 8-char filename + missing shortId to UUID filename + dual-key', async () => {
    const legacyId = 'abcdef12';
    const legacyPath = path.join(clawDir, TASKS_QUEUES_PENDING_DIR, `${legacyId}.json`);
    fs.writeFileSync(legacyPath, JSON.stringify(legacyToolTask(legacyId)));

    const system = makeSystem(clawDir);
    await system.initialize();

    const pendingFiles = fs.readdirSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR));
    expect(pendingFiles).toHaveLength(1);
    expect(pendingFiles[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/);
    expect(pendingFiles[0]).not.toBe(`${legacyId}.json`);

    const migrated = JSON.parse(fs.readFileSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR, pendingFiles[0]), 'utf-8'));
    expect(migrated.id).toBe(pendingFiles[0].replace(/\.json$/, ''));
    expect(migrated.shortId).toBe(legacyId);
    expect(migrated.id).toHaveLength(36);
  });

  it('running legacy file is migrated before recovery (not treated as corrupt)', async () => {
    const legacyId = 'abcdef12';
    const legacyPath = path.join(clawDir, TASKS_QUEUES_RUNNING_DIR, `${legacyId}.json`);
    fs.writeFileSync(legacyPath, JSON.stringify(legacyToolTask(legacyId)));

    const system = makeSystem(clawDir);
    await system.initialize();

    const runningFiles = fs.readdirSync(path.join(clawDir, TASKS_QUEUES_RUNNING_DIR));
    expect(runningFiles).toHaveLength(0);

    const pendingFiles = fs.readdirSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR));
    expect(pendingFiles).toHaveLength(1);
    const migrated = JSON.parse(fs.readFileSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR, pendingFiles[0]), 'utf-8'));
    expect(migrated.shortId).toBe(legacyId);
    expect(migrated.id).toHaveLength(36);
  });

  it('skips already-migrated UUID files without rewriting', async () => {
    const fullId = '550e8400-e29b-41d4-a716-446655440000';
    const task = {
      ...legacyToolTask(fullId),
      shortId: '550e8400',
    };
    fs.writeFileSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR, `${fullId}.json`), JSON.stringify(task));

    const system = makeSystem(clawDir);
    await system.initialize();

    const pendingFiles = fs.readdirSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR));
    expect(pendingFiles).toEqual([`${fullId}.json`]);
    const content = JSON.parse(fs.readFileSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR, pendingFiles[0]), 'utf-8'));
    expect(content.shortId).toBe('550e8400');
  });

  it('blocks init when active task migration has shortId collision', async () => {
    const legacyId = 'abcdef12';
    const fullId = '550e8400-e29b-41d4-a716-446655440000';

    // Pre-populate index with shortId -> different fullId
    const shortIdIndex = new InMemoryShortIdIndex();
    shortIdIndex.add(makeShortTaskId(legacyId), makeFullTaskId('660e8400-e29b-41d4-a716-446655440000'));

    // Phase 867+ format file with same shortId but different fullId
    fs.writeFileSync(path.join(clawDir, TASKS_QUEUES_PENDING_DIR, `${fullId}.json`), JSON.stringify({
      ...legacyToolTask(fullId),
      shortId: legacyId,
    }));

    const system = new AsyncTaskSystem(clawDir, new NodeFileSystem({ baseDir: clawDir }), {
      auditWriter: makeAudit(),
      shortIdIndex,
      ...makeTaskSystemDeps(),
    });

    await expect(system.initialize()).rejects.toThrow(/collision/i);
  });

  it('audits and skips terminal task migration with shortId collision', async () => {
    const legacyId = 'abcdef12';
    const fullId = '550e8400-e29b-41d4-a716-446655440000';

    // Pre-populate index with shortId -> different fullId
    const shortIdIndex = new InMemoryShortIdIndex();
    shortIdIndex.add(makeShortTaskId(legacyId), makeFullTaskId('660e8400-e29b-41d4-a716-446655440000'));

    // Phase 867+ format file in terminal directory with same shortId but different fullId
    fs.writeFileSync(path.join(clawDir, TASKS_QUEUES_DONE_DIR, `${fullId}.json`), JSON.stringify({
      ...legacyToolTask(fullId),
      shortId: legacyId,
    }));

    const { events, writer: auditWriter } = captureAudit();

    const system = new AsyncTaskSystem(clawDir, new NodeFileSystem({ baseDir: clawDir }), {
      auditWriter,
      shortIdIndex,
      ...makeTaskSystemDeps(),
    });

    await system.initialize();

    const collisionEvent = events.find(e => e.type === TASK_AUDIT_EVENTS.SHORT_ID_COLLISION);
    expect(collisionEvent).toBeDefined();
  });

  it('blocks init when active task file is malformed', async () => {
    const badPath = path.join(clawDir, TASKS_QUEUES_PENDING_DIR, 'bad.json');
    fs.writeFileSync(badPath, JSON.stringify(malformedTask()));

    const { events, writer: auditWriter } = captureAudit();

    const system = new AsyncTaskSystem(clawDir, new NodeFileSystem({ baseDir: clawDir }), {
      auditWriter,
      shortIdIndex: new InMemoryShortIdIndex(),
      ...makeTaskSystemDeps(),
    });

    await expect(system.initialize()).rejects.toThrow(/malformed/i);

    const malformedEvent = events.find(e =>
      e.type === TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED &&
      e.cols.some(c => String(c).includes('migrate_malformed')),
    );
    expect(malformedEvent).toBeDefined();
  });

  it('audits and skips terminal task file that is malformed', async () => {
    const badPath = path.join(clawDir, TASKS_QUEUES_DONE_DIR, 'bad.json');
    fs.writeFileSync(badPath, JSON.stringify(malformedTask()));

    const { events, writer: auditWriter } = captureAudit();

    const system = new AsyncTaskSystem(clawDir, new NodeFileSystem({ baseDir: clawDir }), {
      auditWriter,
      shortIdIndex: new InMemoryShortIdIndex(),
      ...makeTaskSystemDeps(),
    });

    await system.initialize();

    const malformedEvent = events.find(e =>
      e.type === TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED &&
      e.cols.some(c => String(c).includes('migrate_malformed')),
    );
    expect(malformedEvent).toBeDefined();
  });

  it('emits only one SHORT_ID_COLLISION audit per terminal migration collision', async () => {
    const legacyId = 'abcdef12';
    const fullId = '550e8400-e29b-41d4-a716-446655440000';

    const shortIdIndex = new InMemoryShortIdIndex();
    shortIdIndex.add(makeShortTaskId(legacyId), makeFullTaskId('660e8400-e29b-41d4-a716-446655440000'));

    fs.writeFileSync(path.join(clawDir, TASKS_QUEUES_DONE_DIR, `${fullId}.json`), JSON.stringify({
      ...legacyToolTask(fullId),
      shortId: legacyId,
    }));

    const { events, writer: auditWriter } = captureAudit();

    const system = new AsyncTaskSystem(clawDir, new NodeFileSystem({ baseDir: clawDir }), {
      auditWriter,
      shortIdIndex,
      ...makeTaskSystemDeps(),
    });

    await system.initialize();

    const collisionEvents = events.filter(e => e.type === TASK_AUDIT_EVENTS.SHORT_ID_COLLISION);
    expect(collisionEvents).toHaveLength(1);
  });

  it('SHORT_ID_COLLISION audit from migration includes context', async () => {
    const legacyId = 'abcdef12';
    const fullId = '550e8400-e29b-41d4-a716-446655440000';

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const shortIdIndex = new PersistentShortIdIndex(nodeFs);
    shortIdIndex.add(makeShortTaskId(legacyId), makeFullTaskId('660e8400-e29b-41d4-a716-446655440000'));
    shortIdIndex.save();

    fs.writeFileSync(path.join(clawDir, TASKS_QUEUES_DONE_DIR, `${fullId}.json`), JSON.stringify({
      ...legacyToolTask(fullId),
      shortId: legacyId,
    }));

    const { events, writer: auditWriter } = captureAudit();

    const system = new AsyncTaskSystem(clawDir, nodeFs, {
      auditWriter,
      shortIdIndex,
      ...makeTaskSystemDeps(),
    });

    await system.initialize();

    const collisionEvent = events.find(e => e.type === TASK_AUDIT_EVENTS.SHORT_ID_COLLISION);
    expect(collisionEvent).toBeDefined();
    expect(collisionEvent!.cols.some(c => String(c) === 'context=migrateLegacyTaskFiles')).toBe(true);
  });
});
