import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { rmSync, mkdirSync, statSync } from 'node:fs';

import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
} from '../../../src/core/async-task-system/dirs.js';
import { createTestTaskSystem, makeTaskSystemDeps } from '../../helpers/task-system.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { PreparedSubagentSchedule } from '../../../src/core/async-task-system/types.js';

function makeAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
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

function makeBasePayload(): PreparedSubagentSchedule['payload'] {
  return {
    kind: 'subagent',
    intent: 'retro summarize',
    timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
    maxSteps: 10,
    parentClawId: 'claw-1',
    mode: 'standard',
  };
}

function makePrepared(overrides?: Partial<PreparedSubagentSchedule>): PreparedSubagentSchedule {
  const id = overrides?.id ?? (`${randomUUID()}` as import('../../../src/core/async-task-system/types.js').FullTaskId);
  return {
    id,
    createdAt: '2026-07-28T00:00:00.000Z',
    payload: { ...makeBasePayload(), ...overrides?.payload },
    ...overrides,
    payload: { ...makeBasePayload(), ...overrides?.payload },
  };
}

async function placeTaskFile(
  fs: FileSystem,
  dir: string,
  fullId: string,
  payload: PreparedSubagentSchedule['payload'],
  createdAt: string,
): Promise<void> {
  const task = {
    ...payload,
    id: fullId,
    shortId: fullId.slice(0, 8),
    createdAt,
  };
  await fs.ensureDir(dir);
  await fs.writeAtomic(`${dir}/${fullId}.json`, JSON.stringify(task, null, 2));
}

describe('AsyncTaskSystem.schedulePrepared (Phase 1206 Step A)', () => {
  let baseDir: string;
  let fs: NodeFileSystem;
  let system: AsyncTaskSystem;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(async () => {
    baseDir = await createTempDir('prepared-schedule-');
    mkdirSync(baseDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir });
    audit = makeAudit();
    system = createTestTaskSystem(baseDir, fs, audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter);
  });

  afterEach(async () => {
    await cleanupTempDir(baseDir);
  });

  it('creates a new pending task when no existing file exists', async () => {
    const prepared = makePrepared();
    const result = await system.schedulePrepared('subagent', prepared);

    expect(result.taskId).toBe(prepared.id);
    expect(result.disposition).toBe('created');

    const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`;
    const exists = await fs.exists(pendingPath);
    expect(exists).toBe(true);

    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });

  it('returns existing for identical payload in each lifecycle directory', async () => {
    const dirs = [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR];
    for (const dir of dirs) {
      rmSync(baseDir, { recursive: true, force: true });
      mkdirSync(baseDir, { recursive: true });
      fs = new NodeFileSystem({ baseDir });
      audit = makeAudit();
      system = createTestTaskSystem(baseDir, fs, audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter);

      const prepared = makePrepared();
      await placeTaskFile(fs, dir, prepared.id, prepared.payload, prepared.createdAt);

      const beforeStat = statSync(path.join(baseDir, `${dir}/${prepared.id}.json`));
      const beforeMtime = beforeStat.mtimeMs;

      const result = await system.schedulePrepared('subagent', prepared);
      expect(result.disposition).toBe('existing');
      expect(result.taskId).toBe(prepared.id);

      const afterStat = statSync(path.join(baseDir, `${dir}/${prepared.id}.json`));
      expect(afterStat.mtimeMs).toBe(beforeMtime);

      const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
      expect(scheduledEvents).toHaveLength(0);

      const confirmedEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_REPLAY_CONFIRMED);
      expect(confirmedEvents).toHaveLength(1);
    }
  });

  it('rejects when same id has different payload', async () => {
    const prepared = makePrepared();
    await placeTaskFile(fs, TASKS_QUEUES_PENDING_DIR, prepared.id, prepared.payload, prepared.createdAt);

    const conflicting = makePrepared({ id: prepared.id, payload: { ...prepared.payload, intent: 'different' } });
    await expect(system.schedulePrepared('subagent', conflicting)).rejects.toThrow(/payload hash mismatch/);

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('rejects when existing file is corrupt JSON', async () => {
    const prepared = makePrepared();
    await fs.ensureDir(TASKS_QUEUES_PENDING_DIR);
    await fs.writeAtomic(`${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`, 'not-json');

    await expect(system.schedulePrepared('subagent', prepared)).rejects.toThrow(/corrupt JSON/);

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('rejects when existing file schema mismatches', async () => {
    const prepared = makePrepared();
    await fs.ensureDir(TASKS_QUEUES_PENDING_DIR);
    await fs.writeAtomic(
      `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`,
      JSON.stringify({ id: prepared.id, shortId: prepared.id.slice(0, 8), createdAt: prepared.createdAt, kind: 'subagent' }),
    );

    await expect(system.schedulePrepared('subagent', prepared)).rejects.toThrow(/schema mismatch/);

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('rejects when task files exist in multiple lifecycle directories', async () => {
    const prepared = makePrepared();
    await placeTaskFile(fs, TASKS_QUEUES_PENDING_DIR, prepared.id, prepared.payload, prepared.createdAt);
    await placeTaskFile(fs, TASKS_QUEUES_DONE_DIR, prepared.id, prepared.payload, prepared.createdAt);

    await expect(system.schedulePrepared('subagent', prepared)).rejects.toThrow(/duplicate task files/);

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('hash is stable regardless of object key order', async () => {
    const prepared = makePrepared();
    await system.schedulePrepared('subagent', prepared);

    const reorderedPayload = {
      mode: prepared.payload.mode,
      intent: prepared.payload.intent,
      timeoutMs: prepared.payload.timeoutMs,
      maxSteps: prepared.payload.maxSteps,
      parentClawId: prepared.payload.parentClawId,
      kind: prepared.payload.kind,
    } as PreparedSubagentSchedule['payload'];
    const reordered = makePrepared({ id: prepared.id, payload: reorderedPayload });

    const result = await system.schedulePrepared('subagent', reordered);
    expect(result.disposition).toBe('existing');
  });

  it('legacy schedule() still returns shortId and writes pending', async () => {
    const payload = makeBasePayload();
    const shortId = await system.schedule('subagent', payload);
    expect(shortId).toBeTruthy();
    expect(shortId.length).toBe(8);

    const pendingFiles = await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    expect(pendingFiles.length).toBe(1);

    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });

  it('does not rewrite existing file mtime on idempotent replay', async () => {
    const prepared = makePrepared();
    await placeTaskFile(fs, TASKS_QUEUES_PENDING_DIR, prepared.id, prepared.payload, prepared.createdAt);

    const beforeStat = statSync(path.join(baseDir, `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`));
    await new Promise(r => setTimeout(r, 20));

    await system.schedulePrepared('subagent', prepared);

    const afterStat = statSync(path.join(baseDir, `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`));
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('keeps file and emits audit when index save fails', async () => {
    const prepared = makePrepared();
    const shortIdIndex = new InMemoryShortIdIndex();
    shortIdIndex.save = () => { throw new Error('disk full'); };

    const customSystem = new AsyncTaskSystem(baseDir, fs, {
      auditWriter: audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter,
      shortIdIndex,
      ...makeTaskSystemDeps(),
    });

    const result = await customSystem.schedulePrepared('subagent', prepared);
    expect(result.disposition).toBe('created');

    const exists = await fs.exists(`${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`);
    expect(exists).toBe(true);

    const scheduledEvent = audit.events.find(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvent).toBeTruthy();
    const indexPersistedCol = scheduledEvent!.find(c => typeof c === 'string' && c.startsWith('indexPersisted='));
    expect(indexPersistedCol).toBe('indexPersisted=false');
  });
});
