/**
 * Phase 1374 sub-4: reconcileFallbackDumps fsync
 * Reverse test ≥3项: mock fs.fsync called post-recovery-write verify
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { reconcileFallbackDumps } from '../../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

const dumpFiles: string[] = [];

async function writeDump(lines: string[]): Promise<string> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const dumpDir = tmpdir();
  let ts = Date.now();
  let p = join(dumpDir, `chestnut-audit-fallback-${process.pid}-${ts}.tsv`);
  while (nodeFs.existsSync(p)) {
    ts++;
    p = join(dumpDir, `chestnut-audit-fallback-${process.pid}-${ts}.tsv`);
  }
  await nodeFsPromises.writeFile(p, lines.join('\n') + '\n');
  dumpFiles.push(p);
  return p;
}

afterEach(async () => {
  for (const p of dumpFiles) {
    try { await nodeFsPromises.unlink(p); } catch { /* silent: test cleanup */ }
  }
  dumpFiles.length = 0;
});

function createMockFs(opts: {
  appendSyncThrows?: boolean;
  syncSyncThrows?: boolean;
}) {
  const appended: Map<string, string> = new Map();
  const synced: string[] = [];

  const mockFs: FileSystem = {
    appendSync: vi.fn((origin: string, content: string) => {
      if (opts.appendSyncThrows) throw new Error('append failed');
      appended.set(origin, (appended.get(origin) || '') + content);
    }),
    syncSync: vi.fn((origin: string) => {
      if (opts.syncSyncThrows) throw new Error('fsync failed');
      synced.push(origin);
    }),
  } as any;

  return { mockFs, appended, synced };
}

describe('phase 1374 sub-4: reconcileFallbackDumps fsync', () => {
  it('reverse 1: fsync called after appendSync for each origin', async () => {
    await writeDump([
      '/test/a.tsv\t2026-05-18T10:00:00.000Z\tevt_a\tcol1',
      '/test/b.tsv\t2026-05-18T10:00:01.000Z\tevt_b\tcol2',
    ]);
    const { mockFs, synced } = createMockFs({});

    await reconcileFallbackDumps(mockFs);

    expect(synced.length).toBe(2);
    expect(synced).toContain('/test/a.tsv');
    expect(synced).toContain('/test/b.tsv');
  });

  it('reverse 2: fsync failure is warned but does not block other origins', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeDump([
      '/test/a.tsv\t2026-05-18T10:00:00.000Z\tevt_a\tcol1',
      '/test/b.tsv\t2026-05-18T10:00:01.000Z\tevt_b\tcol2',
    ]);
    const { mockFs, synced } = createMockFs({ syncSyncThrows: true });

    await reconcileFallbackDumps(mockFs);

    expect(synced.length).toBe(0); // syncSync threw, so no successful syncs recorded
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[AUDIT WARNING\] reconcile fallback fsync failed/),
    );
    consoleErrSpy.mockRestore();
  });

  it('reverse 3: appendSync failure skips fsync for that origin', async () => {
    await writeDump([
      '/test/a.tsv\t2026-05-18T10:00:00.000Z\tevt_a\tcol1',
    ]);
    const { mockFs, synced } = createMockFs({ appendSyncThrows: true });

    await reconcileFallbackDumps(mockFs);

    expect(synced.length).toBe(0);
  });
});
