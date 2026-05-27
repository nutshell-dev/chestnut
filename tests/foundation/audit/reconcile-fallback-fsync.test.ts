/**
 * Phase 1374 sub-4: reconcileFallbackDumps fsync
 * Reverse test ≥3项: mock fs.fsync called post-recovery-write verify
 */

import { describe, it, expect, vi } from 'vitest';
import { reconcileFallbackDumps } from '../../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function createMockFs(opts: {
  dumpContent: string;
  appendSyncThrows?: boolean;
  syncSyncThrows?: boolean;
}) {
  const appended: Map<string, string> = new Map();
  const synced: string[] = [];
  let deletedPath: string | null = null;

  const mockFs: FileSystem = {
    list: vi.fn(async () => [
      { name: 'clawforum-audit-fallback-123-456.tsv', path: 'clawforum-audit-fallback-123-456.tsv', isDirectory: false, isFile: true, size: opts.dumpContent.length },
    ]),
    read: vi.fn(async () => opts.dumpContent),
    appendSync: vi.fn((origin: string, content: string) => {
      if (opts.appendSyncThrows) throw new Error('append failed');
      appended.set(origin, (appended.get(origin) || '') + content);
    }),
    delete: vi.fn(async (path: string) => {
      deletedPath = path;
    }),
    syncSync: vi.fn((origin: string) => {
      if (opts.syncSyncThrows) throw new Error('fsync failed');
      synced.push(origin);
    }),
  } as any;

  return { mockFs, appended, synced, deletedPath: () => deletedPath };
}

describe('phase 1374 sub-4: reconcileFallbackDumps fsync', () => {
  it('reverse 1: fsync called after appendSync for each origin', async () => {
    const dumpContent = '/test/a.tsv\t2026-05-18T10:00:00.000Z\tevt_a\tcol1\n/test/b.tsv\t2026-05-18T10:00:01.000Z\tevt_b\tcol2\n';
    const { mockFs, synced } = createMockFs({ dumpContent });

    await reconcileFallbackDumps(mockFs);

    expect(synced.length).toBe(2);
    expect(synced).toContain('/test/a.tsv');
    expect(synced).toContain('/test/b.tsv');
  });

  it('reverse 2: fsync failure is warned but does not block other origins', async () => {
    const dumpContent = '/test/a.tsv\t2026-05-18T10:00:00.000Z\tevt_a\tcol1\n/test/b.tsv\t2026-05-18T10:00:01.000Z\tevt_b\tcol2\n';
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { mockFs, synced } = createMockFs({ dumpContent, syncSyncThrows: true });

    await reconcileFallbackDumps(mockFs);

    expect(synced.length).toBe(0); // syncSync threw, so no successful syncs recorded
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[AUDIT WARNING\] reconcile fallback fsync failed/),
    );
    consoleErrSpy.mockRestore();
  });

  it('reverse 3: appendSync failure skips fsync for that origin', async () => {
    const dumpContent = '/test/a.tsv\t2026-05-18T10:00:00.000Z\tevt_a\tcol1\n';
    const { mockFs, synced } = createMockFs({ dumpContent, appendSyncThrows: true });

    await reconcileFallbackDumps(mockFs);

    expect(synced.length).toBe(0);
  });
});
