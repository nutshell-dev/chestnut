/**
 * Phase 1011 D.2: inbox-reader peekMetas race skip audit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboxReader } from '../../../src/foundation/messaging/index.js';
import { InboxWriter } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { encodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

// Mock InboxWriter.readMeta
vi.mock('../../../src/foundation/messaging/inbox-writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/messaging/inbox-writer.js')>();
  return {
    ...actual,
    InboxWriter: {
      ...actual.InboxWriter,
      readMeta: vi.fn(),
    },
  };
});

function makeMockFs(): FileSystem {
  return {
    list: vi.fn().mockResolvedValue([{ name: 'msg.md', path: '/inbox/pending/msg.md' }]),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    mkdirExclusiveSync: vi.fn(),
    writeAtomic: vi.fn().mockResolvedValue({ kind: 'durable' }),
  } as unknown as FileSystem;
}

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
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

describe('phase 1011 D.2: inbox-reader peekMetas race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('peekMetas readMeta not_found emits INBOX_PEEK_RACE_SKIP not INBOX_META_FAILED', async () => {
    const mockFs = makeMockFs();
    const { audit, events } = makeMockAudit();
    const reader = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit);

    const { InboxWriter } = await import('../../../src/foundation/messaging/inbox-writer.js');
    vi.mocked(InboxWriter.readMeta).mockReturnValue({
      ok: false,
      error: { kind: 'not_found' },
    } as any);

    await reader.peekMetas();

    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_PEEK_RACE_SKIP)).toBe(true);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_META_FAILED)).toBe(false);
  });

  it('peekMetas readMeta parse_failed still emits INBOX_META_FAILED', async () => {
    const mockFs = makeMockFs();
    const { audit, events } = makeMockAudit();
    const reader = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit);

    const { InboxWriter } = await import('../../../src/foundation/messaging/inbox-writer.js');
    vi.mocked(InboxWriter.readMeta).mockReturnValue({
      ok: false,
      error: { kind: 'parse_failed' },
    } as any);

    await reader.peekMetas();

    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_PEEK_RACE_SKIP)).toBe(false);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_META_FAILED)).toBe(true);
  });
});


describe('phase 2046 Step C: pending read/markFailed races', () => {
  const goodWire = encodeInbox({
    id: 'good', type: 'message', from: 'sender', to: 'claw',
    content: 'hello', priority: 'normal', timestamp: new Date().toISOString(),
  });

  function makeDrainFs(
    read: (filePath: string) => Promise<string>,
    move: (from: string, to: string) => Promise<void> = async () => {},
  ): FileSystem {
    return {
      list: vi.fn(async (dir: string) => dir === '/inbox/pending'
        ? ['bad.md', 'good.md'].map(name => ({ name, path: `/inbox/pending/${name}` }))
        : []),
      read: vi.fn(read),
      move: vi.fn(move),
      utimes: vi.fn().mockResolvedValue(undefined),
      mkdirExclusiveSync: vi.fn(),
      writeAtomic: vi.fn().mockResolvedValue({ kind: 'durable' }),
    } as unknown as FileSystem;
  }

  it('skips a pending file that vanishes between list and read and delivers the rest', async () => {
    const mockFs = makeDrainFs(async filePath => {
      if (filePath.endsWith('/bad.md')) throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
      return goodWire;
    });
    const { audit, events } = makeMockAudit();
    const reader = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit);

    const result = await reader.drainAndDeliver();

    expect(result.kind).toBe('complete');
    expect(result.entries.map(entry => entry.message.id)).toEqual(['good']);
    expect(result.handles).toHaveLength(1);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_FAILED)).toBe(false);
  });

  it('continues when a malformed file vanishes before markFailed', async () => {
    const mockFs = makeDrainFs(
      async filePath => filePath.endsWith('/bad.md') ? 'not an inbox message' : goodWire,
      async from => {
        if (from.endsWith('/bad.md')) throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
      },
    );
    const { audit } = makeMockAudit();
    const reader = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit);

    const result = await reader.drainAndDeliver();

    expect(result.kind).toBe('complete');
    expect(result.entries.map(entry => entry.message.id)).toEqual(['good']);
    expect(result.permanentErrors).toBe(1);
  });

  it('keeps a real EIO as a transient read error instead of skipping it', async () => {
    const mockFs = makeDrainFs(async filePath => {
      if (filePath.endsWith('/bad.md')) throw Object.assign(new Error('I/O failed'), { code: 'EIO' });
      return goodWire;
    });
    const { audit, events } = makeMockAudit();
    const reader = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit);

    const result = await reader.drainAndDeliver();

    expect(result.kind).toBe('complete');
    expect(result.entries.map(entry => entry.message.id)).toEqual(['good']);
    expect(result.transientErrors).toBe(1);
    const failed = events.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0].join('\t')).toContain('error_code=EIO');
  });
});
