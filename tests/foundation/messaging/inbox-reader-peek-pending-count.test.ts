import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createInboxReader, InboxReader } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: {
      write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    },
    events,
  };
}

describe('InboxReader.peekPendingCount', () => {
  let root: string;
  let pendingDir: string;
  let fs: NodeFileSystem;
  let reader: InboxReader;
  let auditEvents: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `peek-count-${randomUUID()}`);
    pendingDir = path.join(root, 'inbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit, events } = makeAudit();
    auditEvents = events;
    reader = createInboxReader(fs, audit, root);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns 0 when pending dir is missing', async () => {
    await fsAsync.rm(pendingDir, { recursive: true });
    expect(await reader.peekPendingCount()).toEqual({ kind: 'empty', value: 0 });
    expect(auditEvents.filter(e => String(e[0]).includes('list_failed'))).toEqual([]);
  });

  it('returns 0 when pending is empty', async () => {
    expect(await reader.peekPendingCount()).toEqual({ kind: 'empty', value: 0 });
  });

  it('counts only .md files', async () => {
    await fsAsync.writeFile(path.join(pendingDir, 'a.md'), 'x');
    await fsAsync.writeFile(path.join(pendingDir, 'b.md'), 'x');
    await fsAsync.writeFile(path.join(pendingDir, 'c.json'), 'x');
    await fsAsync.writeFile(path.join(pendingDir, 'd.tmp'), 'x');
    expect(await reader.peekPendingCount()).toEqual({ kind: 'found', value: 2 });
  });

  it.each(['EACCES', 'EIO'])('emits list_failed audit and preserves %s as unavailable', async (code) => {
    const boom = Object.assign(new Error(code), { code });
    const mockFs: FileSystem = {
      ...fs,
      list: vi.fn().mockRejectedValue(boom),
    };
    const { audit, events } = makeAudit();
    const mockReader = createInboxReader(mockFs, audit, root);
    expect(await mockReader.peekPendingCount()).toEqual({
      kind: 'unavailable',
      stage: 'list',
      path: pendingDir,
      error: boom,
    });
    expect(events.some(e => String(e[0]).includes('list_failed') && String(e).includes("op=peek_count"))).toBe(true);
  });
});
