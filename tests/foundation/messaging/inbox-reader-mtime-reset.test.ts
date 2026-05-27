import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboxReader } from '../../../src/foundation/messaging/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeMockFs(): FileSystem {
  return {
    list: vi.fn().mockResolvedValue([{ name: 'msg.md', path: '/inbox/pending/msg.md' }]),
    read: vi.fn().mockResolvedValue(
      '---\nid: msg-1\ntype: message\nfrom: "sender"\nto: "receiver"\npriority: normal\ntimestamp: 2026-05-27T00:00:00Z\n---\n\nbody\n',
    ),
    move: vi.fn().mockResolvedValue(undefined),
    utimes: vi.fn().mockResolvedValue(undefined),
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

describe('inbox-reader drainAndDeliver mtime reset (phase 1372 sub-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets mtime after moving file to inflight', async () => {
    const mockFs = makeMockFs();
    const { audit } = makeMockAudit();
    const reader = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit, '/inbox/inflight');

    const before = Date.now();
    const result = await reader.drainAndDeliver();
    const after = Date.now();

    expect(result.entries.length).toBe(1);
    expect(result.handles.length).toBe(1);

    expect(mockFs.move).toHaveBeenCalledTimes(1);
    expect(mockFs.move).toHaveBeenCalledWith('/inbox/pending/msg.md', '/inbox/inflight/msg.md');

    expect(mockFs.utimes).toHaveBeenCalledTimes(1);
    expect(mockFs.utimes).toHaveBeenCalledWith('/inbox/inflight/msg.md', expect.any(Date), expect.any(Date));

    const utimesCall = (mockFs.utimes as ReturnType<typeof vi.fn>).mock.calls[0];
    const mtimeArg = utimesCall[2] as Date;
    expect(mtimeArg.getTime()).toBeGreaterThanOrEqual(before);
    expect(mtimeArg.getTime()).toBeLessThanOrEqual(after);
  });

  it('does not call utimes when move fails', async () => {
    const mockFs = makeMockFs();
    (mockFs.move as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EIO'));
    const { audit } = makeMockAudit();
    const reader = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit, '/inbox/inflight');

    const result = await reader.drainAndDeliver();

    expect(result.entries.length).toBe(0);
    expect(result.handles.length).toBe(0);
    expect(mockFs.utimes).not.toHaveBeenCalled();
  });
});
