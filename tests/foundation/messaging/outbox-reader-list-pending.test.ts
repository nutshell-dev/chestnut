import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: { write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); } , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s},
    events,
  };
}

describe('OutboxReader.listClawOutboxPending', () => {
  let root: string;
  let clawDir: string;
  let fs: NodeFileSystem;
  let reader: OutboxReader;
  let auditEvents: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    root = path.join(tmpdir(), `outbox-reader-${randomUUID()}`);
    clawDir = path.join(root, 'claws/clawA');
    await fsAsync.mkdir(clawDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit, events } = makeAudit();
    auditEvents = events;
    reader = new OutboxReader(fs, audit);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns empty array when outbox/pending dir missing', async () => {
    const files = await reader.listClawOutboxPending(clawDir);
    expect(files).toEqual([]);
    expect(auditEvents.filter(e => String(e[0]).includes('list_failed'))).toEqual([]);
  });

  it('returns sorted .md filenames in pending', async () => {
    const pendingDir = path.join(clawDir, 'outbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.writeFile(path.join(pendingDir, 'b.md'), 'x');
    await fsAsync.writeFile(path.join(pendingDir, 'a.md'), 'x');
    const files = await reader.listClawOutboxPending(clawDir);
    expect(files).toEqual(['a.md', 'b.md']);
  });

  it('filters non-.md files', async () => {
    const pendingDir = path.join(clawDir, 'outbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.writeFile(path.join(pendingDir, 'a.md'), 'x');
    await fsAsync.writeFile(path.join(pendingDir, 'b.json'), 'x');
    await fsAsync.writeFile(path.join(pendingDir, 'c.tmp'), 'x');
    const files = await reader.listClawOutboxPending(clawDir);
    expect(files).toEqual(['a.md']);
  });

  it('returns empty when pending is empty', async () => {
    const pendingDir = path.join(clawDir, 'outbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    const files = await reader.listClawOutboxPending(clawDir);
    expect(files).toEqual([]);
  });
});
