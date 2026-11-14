import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { ToolTask } from '../../../src/core/async-task-system/types.js';
import {
  RECOVERY_BATCH_DIR,
  RECOVERY_FALLBACK_FILE,
  type RecoveryNotice,
} from '../../../src/core/async-task-system/recovery-fallback.js';
import {
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_QUEUES_RUNNING_DIR,
} from '../../../src/core/async-task-system/dirs.js';

function makeAudit(): AuditLog {
  return {
    write: () => { /* test sink */ },
    preview: (value: string) => value,
    message: (value: string) => value,
    summary: (value: string) => value,
  };
}

function makeToolTask(id: string, parentClawId = 'parent'): ToolTask {
  return {
    kind: 'tool',
    id,
    shortId: id.slice(0, 8),
    toolName: 'exec',
    args: { command: 'non-idempotent' },
    parentClawDir: '/tmp',
    parentClawId,
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
  };
}

describe('Phase 2150 B3: recovery fallback aggregation', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `phase2150-recovery-${randomUUID()}`);
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    await Promise.all([
      TASKS_QUEUES_PENDING_DIR,
      TASKS_QUEUES_RUNNING_DIR,
      TASKS_QUEUES_FAILED_DIR,
      TASKS_QUEUES_RESULTS_DIR,
    ].map(dir => fs.mkdir(path.join(tmpDir, dir), { recursive: true })));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedRunning(count: number, parentClawId = 'parent'): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    for (const id of ids) {
      await fs.writeFile(
        path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${id}.json`),
        JSON.stringify(makeToolTask(id, parentClawId)),
      );
    }
    return ids;
  }

  async function readNotices(): Promise<RecoveryNotice[]> {
    const files = (await fs.readdir(path.join(tmpDir, 'inbox/pending'))).filter(name => name.endsWith('.md'));
    return Promise.all(files.map(async name => {
      const message = decodeInbox(await fs.readFile(path.join(tmpDir, 'inbox/pending', name), 'utf8'));
      return JSON.parse(message.content) as RecoveryNotice;
    }));
  }

  it('keeps 21 per-task artifacts while writing two bounded notices and manifests', async () => {
    const ids = await seedRunning(21);

    await recoverTasks({ fs: nodeFs, auditWriter: makeAudit() });

    const notices = await readNotices();
    expect(notices).toHaveLength(2);
    expect(notices.map(n => n.items.length).sort((a, b) => a - b)).toEqual([1, 20]);
    expect(notices.every(n => n.aggregated && n.partial)).toBe(true);
    const items = notices.flatMap(n => n.items);
    expect(new Set(items.map(item => item.fullTaskId))).toEqual(new Set(ids));
    for (const id of ids) {
      const artifact = JSON.parse(await fs.readFile(
        path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, id, RECOVERY_FALLBACK_FILE),
        'utf8',
      ));
      expect(artifact.fullTaskId).toBe(id);
      expect(artifact.result.content).toContain('Manual intervention required');
      expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, id, 'result.txt.notified')).then(() => true)).toBe(true);
      expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${id}.json`)).then(() => true)).toBe(true);
    }
    expect((await fs.readdir(path.join(tmpDir, RECOVERY_BATCH_DIR))).filter(name => name.endsWith('.json'))).toHaveLength(2);
    expect((await fs.readdir(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR))).filter(name => name.endsWith('.json'))).toHaveLength(0);
  });

  it('keeps running artifacts on inbox failure and retries the aggregate on the next pass', async () => {
    const [id] = await seedRunning(1);
    const writeInboxAsync = vi.fn()
      .mockRejectedValueOnce(new Error('injected inbox EIO'))
      .mockImplementation(async () => { /* second pass commits */ });
    const deps: RecoverTasksDeps = { fs: nodeFs, auditWriter: makeAudit(), writeInboxAsync };

    await recoverTasks(deps);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${id}.json`)).then(() => true)).toBe(true);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, id, 'result.txt.notified')).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, id, RECOVERY_FALLBACK_FILE)).then(() => true)).toBe(true);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${id}.json`)).then(() => true).catch(() => false)).toBe(false);

    await recoverTasks(deps);
    expect(writeInboxAsync).toHaveBeenCalledTimes(2);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${id}.json`)).then(() => true)).toBe(true);
  });

  it('does not write inbox or settle tasks when the batch manifest cannot be persisted', async () => {
    const [id] = await seedRunning(1);
    const realWriteAtomic = nodeFs.writeAtomic.bind(nodeFs);
    let failManifest = true;
    vi.spyOn(nodeFs, 'writeAtomic').mockImplementation(async (filePath, content) => {
      if (failManifest && filePath.includes(RECOVERY_BATCH_DIR)) {
        failManifest = false;
        throw new Error('injected manifest EIO');
      }
      return realWriteAtomic(filePath, content);
    });
    const writeInboxAsync = vi.fn().mockResolvedValue(undefined);
    const deps = { fs: nodeFs, auditWriter: makeAudit(), writeInboxAsync };

    await recoverTasks(deps);
    expect(writeInboxAsync).not.toHaveBeenCalled();
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${id}.json`)).then(() => true)).toBe(true);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, id, RECOVERY_FALLBACK_FILE)).then(() => true)).toBe(true);

    await recoverTasks(deps);
    expect(writeInboxAsync).toHaveBeenCalledTimes(1);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${id}.json`)).then(() => true)).toBe(true);
  });

  it('allows an at-least-once resend when the per-task marker fails after batch delivery', async () => {
    const [id] = await seedRunning(1);
    const realWriteAtomic = nodeFs.writeAtomic.bind(nodeFs);
    let failMarker = true;
    vi.spyOn(nodeFs, 'writeAtomic').mockImplementation(async (filePath, content) => {
      if (failMarker && filePath.endsWith('result.txt.notified')) {
        failMarker = false;
        throw new Error('injected marker EIO');
      }
      return realWriteAtomic(filePath, content);
    });

    await recoverTasks({ fs: nodeFs, auditWriter: makeAudit() });
    expect(await readNotices()).toHaveLength(1);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${id}.json`)).then(() => true)).toBe(true);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${id}.json`)).then(() => true).catch(() => false)).toBe(false);

    await recoverTasks({ fs: nodeFs, auditWriter: makeAudit() });
    expect(await readNotices()).toHaveLength(2);
    expect(await fs.stat(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${id}.json`)).then(() => true)).toBe(true);
  });
});
