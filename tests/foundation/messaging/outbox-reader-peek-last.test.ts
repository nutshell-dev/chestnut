import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import type { OutboxMessage } from '../../../src/foundation/messaging/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: { write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); } , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s},
    events,
  };
}

function makeMsg(content: string, ts: string, priority: OutboxMessage['priority'] = 'normal'): OutboxMessage {
  return {
    id: `m-${ts}`,
    type: 'response',
    from: 'clawA',
    to: 'motion',
    content,
    timestamp: ts,
    priority,
  };
}

describe('OutboxReader.peekLastOutboxPending', () => {
  let root: string;
  let clawDir: string;
  let pendingDir: string;
  let fs: NodeFileSystem;
  let reader: OutboxReader;
  let auditEvents: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    root = path.join(tmpdir(), `peek-last-${randomUUID()}`);
    clawDir = path.join(root, 'claws/clawA');
    pendingDir = path.join(clawDir, 'outbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit, events } = makeAudit();
    auditEvents = events;
    reader = new OutboxReader(fs, audit);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns null when pending empty', async () => {
    expect(await reader.peekLastOutboxPending(clawDir)).toBeNull();
    expect(auditEvents.filter(e => String(e[0]).includes('peek_failed'))).toEqual([]);
  });

  it('returns null when pending dir missing', async () => {
    await fsAsync.rm(pendingDir, { recursive: true });
    expect(await reader.peekLastOutboxPending(clawDir)).toBeNull();
  });

  it('returns latest message by filename sort order', async () => {
    const t1 = '1717480000000';
    const t2 = '1717480000001';
    await fsAsync.writeFile(
      path.join(pendingDir, `${t1}_normal_aaa.md`),
      encodeOutbox(makeMsg('earlier', '2026-06-04T10:00:00Z')),
    );
    await fsAsync.writeFile(
      path.join(pendingDir, `${t2}_normal_bbb.md`),
      encodeOutbox(makeMsg('LATER', '2026-06-04T11:00:00Z')),
    );
    const result = await reader.peekLastOutboxPending(clawDir);
    expect(result).not.toBeNull();
    expect(result?.message.content).toBe('LATER');
    expect(result?.filename).toBe(`${t2}_normal_bbb.md`);
  });

  it('filters non-.md files in last-pick', async () => {
    const t1 = '1717480000000';
    await fsAsync.writeFile(
      path.join(pendingDir, `${t1}_normal_aaa.md`),
      encodeOutbox(makeMsg('hello', '2026-06-04T10:00:00Z')),
    );
    await fsAsync.writeFile(path.join(pendingDir, 'zzz_garbage.tmp'), 'noise');
    const result = await reader.peekLastOutboxPending(clawDir);
    expect(result?.message.content).toBe('hello');
  });

  it('returns null + audit on decode failure', async () => {
    const t1 = '1717480000000';
    await fsAsync.writeFile(
      path.join(pendingDir, `${t1}_normal_aaa.md`),
      'NOT VALID YAML/FRONTMATTER',
    );
    const result = await reader.peekLastOutboxPending(clawDir);
    expect(result).toBeNull();
    expect(auditEvents.some(e => String(e[0]).includes('peek_failed'))).toBe(true);
  });

  it('returns null + audit when file unexpectedly gone (race with consumer)', async () => {
    const t1 = '1717480000000';
    const filename = `${t1}_normal_aaa.md`;
    await fsAsync.writeFile(
      path.join(pendingDir, filename),
      encodeOutbox(makeMsg('x', '2026-06-04T10:00:00Z')),
    );
    // Hook: list sees the file, then delete before read
    const originalList = reader.listClawOutboxPending.bind(reader);
    reader.listClawOutboxPending = async (dir: string) => {
      const list = await originalList(dir);
      if (list.includes(filename)) {
        await fsAsync.rm(path.join(pendingDir, filename)).catch(() => { /* silent: cleanup */ });
      }
      return list;
    };
    const result = await reader.peekLastOutboxPending(clawDir);
    expect(result).toBeNull();
    expect(auditEvents.some(e => String(e[0]).includes('peek_failed') && String(e).includes('stage=read'))).toBe(true);
  });
});
