/**
 * Phase 1011 D.2: inbox-reader peekMetas race skip audit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboxReader } from '../../../src/foundation/messaging/index.js';
import { InboxWriter } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
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
  } as unknown as FileSystem;
}

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
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
