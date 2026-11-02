import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { OutboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeOutboxPath } from '../../../src/foundation/messaging/outbox-writer.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

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

const OPTIONS = { type: 'report' as const, to: 'claw-b', content: 'hello' };

describe('outbox write durability degradation (Phase 2049 Step E)', () => {
  let root: string;
  let pendingDir: string;
  let fs: NodeFileSystem;
  let writer: OutboxWriter;
  let events: Array<[string, ...unknown[]]>;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `outbox-durability-${randomUUID()}`);
    pendingDir = path.join(root, 'outbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const made = makeAudit();
    events = made.events;
    writer = OutboxWriter.__internal_create(
      'claw-a',
      makeOutboxPath('claw-a', root),
      fs,
      made.audit,
      MESSAGING_WRITER_LIMITS_DEFAULT,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function durabilityEvents() {
    return events.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_WRITE_DURABILITY_DEGRADED);
  }

  it('audits a committed non-durable write and still emits outbox_sent', async () => {
    const degradedErr = Object.assign(new Error('dir fsync EINVAL'), { code: 'EINVAL' });
    const realWriteAtomic = fs.writeAtomic.bind(fs);
    vi.spyOn(fs, 'writeAtomic').mockImplementationOnce(async (p, c) => {
      await realWriteAtomic(p, c);
      return { kind: 'committed_platform_limited', error: degradedErr };
    });

    const writtenPath = await writer.write(OPTIONS);

    expect(durabilityEvents()).toHaveLength(1);
    expect(String(durabilityEvents()[0])).toContain('durability=committed_platform_limited');
    expect(String(durabilityEvents()[0])).toContain('dir fsync EINVAL');
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)).toBe(true);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SEND_FAILED)).toBe(false);
    await expect(fsAsync.readFile(writtenPath, 'utf8')).resolves.toContain('hello');
  });

  it('does not emit a degradation event for a durable write', async () => {
    await writer.write(OPTIONS);

    expect(durabilityEvents()).toHaveLength(0);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)).toBe(true);
  });

  it('preserves the send-failed path when writeAtomic throws before commit', async () => {
    vi.spyOn(fs, 'writeAtomic').mockRejectedValueOnce(new Error('EIO before rename'));

    await expect(writer.write(OPTIONS)).rejects.toThrow('EIO before rename');

    expect(durabilityEvents()).toHaveLength(0);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)).toBe(false);
    expect(events.some(e =>
      e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SEND_FAILED && String(e).includes('EIO before rename')
    )).toBe(true);
  });
});
