/**
 * DialogStore.restoreBefore tests (phase 767)
 */

import { describe, it, expect, vi } from 'vitest';
import { makeSession } from '../../helpers/session-fixtures.js';
import { DialogStore, MarkerNotFoundError } from '../../../src/foundation/dialog-store/store.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeMockAudit() {
  return { write: vi.fn() };
}

function makeMockFs(opts: {
  currentContent: string;
  archives?: Array<{ name: string; content: string }>;
}): FileSystem {
  const archiveMap = new Map(opts.archives?.map(a => [`dialog/archive/${a.name}`, a.content]));
  return {
    read: vi.fn(async (p: string) => {
      if (p === 'dialog/current.json') return opts.currentContent;
      if (archiveMap.has(p)) return archiveMap.get(p)!;
      const err = new Error(`ENOENT: ${p}`) as any;
      err.code = 'ENOENT';
      throw err;
    }),
    list: vi.fn(async (p: string) => {
      if (p === 'dialog/archive') {
        return (opts.archives ?? []).map((a, i) => ({
          name: a.name,
          path: `dialog/archive/${a.name}`,
          isFile: true,
          isDirectory: false,
          size: a.content.length,
          mtime: new Date(1000 + i),
        } as FileEntry));
      }
      return [];
    }),
    ensureDir: vi.fn(async () => {}),
    writeAtomic: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    append: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    isDirectory: vi.fn(async () => false),
    stat: vi.fn(async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
    writeAtomicSync: vi.fn(() => {}),
    writeExclusiveSync: vi.fn(() => {}),
    readSync: vi.fn(() => ''),
    readBytesSync: vi.fn(() => Buffer.from('')),
    appendSync: vi.fn(() => {}),
    statSync: vi.fn(() => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
    moveSync: vi.fn(() => {}),
    existsSync: vi.fn(() => false),
    ensureDirSync: vi.fn(() => {}),
    listSync: vi.fn(() => []),
    deleteSync: vi.fn(() => {}),
    resolve: vi.fn((p: string) => `/base/${p}`),
  } as unknown as FileSystem;
}

describe('DialogStore restoreBefore', () => {
  it('restoreBefore excludes marker assistant', async () => {
    const audit = makeMockAudit();
    const session = makeSession({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'marker-1', name: 'shadow', input: {} }] },
        { role: 'user', content: 'after' },
      ],
    });
    const fs = makeMockFs({ currentContent: JSON.stringify(session) });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const before = await store.restoreBefore({ clawId: 'c1', toolUseId: 'marker-1' });
    const prefix = await store.restorePrefix({ clawId: 'c1', toolUseId: 'marker-1' });

    expect(before.messages).toHaveLength(2); // excludes marker
    expect(prefix.messages).toHaveLength(3); // includes marker
    expect(before.messages).toEqual(prefix.messages.slice(0, -1));
  });

  it('restoreBefore returns same systemPrompt and toolsForLLM as restorePrefix', async () => {
    const audit = makeMockAudit();
    const session = makeSession({
      systemPrompt: 'test-prompt',
      toolsForLLM: [{ name: 'read', description: 'd', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'marker-2', name: 'shadow', input: {} }] },
      ],
    });
    const fs = makeMockFs({ currentContent: JSON.stringify(session) });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const before = await store.restoreBefore({ clawId: 'c1', toolUseId: 'marker-2' });
    const prefix = await store.restorePrefix({ clawId: 'c1', toolUseId: 'marker-2' });

    expect(before.systemPrompt).toBe(prefix.systemPrompt);
    expect(before.toolsForLLM).toEqual(prefix.toolsForLLM);
  });

  it('restoreBefore falls back to archive when marker not in current', async () => {
    const audit = makeMockAudit();
    const current = makeSession({ messages: [{ role: 'user', content: 'current' }] });
    const archive = makeSession({
      messages: [
        { role: 'user', content: 'archive-msg' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'marker-3', name: 'shadow', input: {} }] },
      ],
    });
    const fs = makeMockFs({
      currentContent: JSON.stringify(current),
      archives: [{ name: '2000_a.json', content: JSON.stringify(archive) }],
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.restoreBefore({ clawId: 'c1', toolUseId: 'marker-3' });

    expect(result.messages).toHaveLength(1);
    expect(result.meta.foundIn).toBe('archive');
  });

  it('restoreBefore throws MarkerNotFoundError when marker absent', async () => {
    const audit = makeMockAudit();
    const session = makeSession({ messages: [{ role: 'user', content: 'hi' }] });
    const fs = makeMockFs({ currentContent: JSON.stringify(session) });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    await expect(store.restoreBefore({ clawId: 'c1', toolUseId: 'missing' })).rejects.toThrow(MarkerNotFoundError);
  });

  it('restoreBefore returns empty messages when marker is first', async () => {
    const audit = makeMockAudit();
    const session = makeSession({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'marker-first', name: 'shadow', input: {} }] },
      ],
    });
    const fs = makeMockFs({ currentContent: JSON.stringify(session) });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.restoreBefore({ clawId: 'c1', toolUseId: 'marker-first' });

    expect(result.messages).toHaveLength(0);
  });
});
