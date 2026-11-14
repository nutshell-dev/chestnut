import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createOutboxReader, type OutboxReader } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { formatErr } from '../../../src/foundation/node-utils/index.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: { write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); } },
    events,
  };
}

describe('OutboxReader.listPendingResult', () => {
  let root: string;
  let clawDir: string;
  let fs: NodeFileSystem;
  let reader: OutboxReader;
  let auditEvents: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `outbox-reader-${randomUUID()}`);
    clawDir = path.join(root, 'claws/clawA');
    await fsAsync.mkdir(clawDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit, events } = makeAudit();
    auditEvents = events;
    reader = createOutboxReader({ clawRoot: clawDir, fs, audit });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns empty when outbox/pending dir missing', async () => {
    await expect(reader.listPendingResult()).resolves.toEqual({ kind: 'empty', files: [] });
    expect(auditEvents.filter(e => String(e[0]).includes('list_failed'))).toEqual([]);
  });

  it('returns sorted .md filenames in pending', async () => {
    const pendingDir = path.join(clawDir, 'outbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.writeFile(path.join(pendingDir, 'b.md'), 'x');
    await fsAsync.writeFile(path.join(pendingDir, 'a.md'), 'x');
    await expect(reader.listPendingResult()).resolves.toEqual({ kind: 'found', files: ['a.md', 'b.md'] });
  });

  it('filters non-.md files and reports an empty result', async () => {
    const pendingDir = path.join(clawDir, 'outbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.writeFile(path.join(pendingDir, 'b.json'), 'x');
    await fsAsync.writeFile(path.join(pendingDir, 'c.tmp'), 'x');
    await expect(reader.listPendingResult()).resolves.toEqual({ kind: 'empty', files: [] });
  });

  it('returns failed with the original error and audits the same reason', async () => {
    const error = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const mockFs = { list: vi.fn().mockRejectedValue(error) } as unknown as NodeFileSystem;
    const { audit, events } = makeAudit();
    const failedReader = createOutboxReader({ clawRoot: clawDir, fs: mockFs, audit });

    await expect(failedReader.listPendingResult()).resolves.toEqual({
      kind: 'failed',
      stage: 'list',
      path: path.join(clawDir, 'outbox/pending'),
      error,
    });
    expect(events).toEqual([[
      'outbox_list_failed',
      `dir=${path.join(clawDir, 'outbox/pending')}`,
      `reason=${formatErr(error)}`,
    ]]);
  });
});
