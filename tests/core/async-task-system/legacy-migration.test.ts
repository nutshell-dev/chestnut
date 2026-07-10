import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR } from '../../../src/core/async-task-system/dirs.js';
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
    isIdempotent: false,
    maxRetries: 2,
    retryCount: 0,
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
});
