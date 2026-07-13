/**
 * Snapshot cleanup race/safety cluster (phase 998 H.1+H.2+H.3)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { Snapshot } from '../../../src/foundation/snapshot/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!gitAvailable)('Snapshot cleanup race/safety cluster (phase 998)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snap-race-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // ========================================================================
  // H.1: preserve dir invariant during cleanup (no ENOENT race window)
  // ========================================================================

  it('H.1: preserves dir invariant during cleanup (never calls removeDir on the cleanup dir itself)', async () => {
    const baseFs = new NodeFileSystem({ baseDir: tmpDir });
    const fs = Object.create(baseFs);
    const scratchDir = path.join(tmpDir, 'tasks', 'sync', 'exec');
    const subDir = path.join(scratchDir, 'nested');
    await baseFs.ensureDir(subDir);
    await fsp.writeFile(path.join(scratchDir, 'old.md'), 'old');
    await fsp.writeFile(path.join(subDir, 'nested.md'), 'nested');

    const snapshot = new Snapshot(tmpDir, fs, makeMockAudit(), [], [scratchDir]);
    await snapshot.init();

    const removeDirSpy = vi.spyOn(fs, 'removeDir');
    const ensureDirSpy = vi.spyOn(fs, 'ensureDir');

    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    const result = await snapshot.commit('test-h1');
    expect(result.ok).toBe(true);

    // removeDir should never be called with the cleanup dir itself (invariant preserved)
    const relScratch = path.relative(tmpDir, scratchDir);
    expect(removeDirSpy).not.toHaveBeenCalledWith(relScratch);

    // ensureDir should not be called on the cleanup dir (no reconstruction needed)
    expect(ensureDirSpy).not.toHaveBeenCalledWith(relScratch);

    // nested subdir may be removed, but parent dir stays
    expect(fsSync.existsSync(scratchDir)).toBe(true);
  });

  // ========================================================================
  // H.2: sorts syncCleanupDirs by depth (deepest first)
  // ========================================================================

  it('H.2: sorts syncCleanupDirs by depth so deepest dir is cleared first', async () => {
    const baseFs = new NodeFileSystem({ baseDir: tmpDir });
    const fs = Object.create(baseFs);
    const parentDir = path.join(tmpDir, 'parent');
    const childDir = path.join(tmpDir, 'parent', 'sub');
    await baseFs.ensureDir(childDir);
    await fsp.writeFile(path.join(parentDir, 'parent-file.md'), 'parent');
    await fsp.writeFile(path.join(childDir, 'child-file.md'), 'child');

    // Pass parent first, child second — unsorted order
    const snapshot = new Snapshot(tmpDir, fs, makeMockAudit(), [], [parentDir, childDir]);
    await snapshot.init();

    // Record call order of list (which dir is processed first)
    const listCalls: string[] = [];
    const originalList = baseFs.list.bind(baseFs);
    fs.list = vi.fn().mockImplementation(async (dir: string, opts?: object) => {
      listCalls.push(dir);
      return originalList(dir, opts);
    });

    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    const result = await snapshot.commit('test-h2');
    expect(result.ok).toBe(true);

    // deepest (parent/sub) should be listed/cleared before parent
    expect(listCalls[0]).toBe('parent/sub');
    expect(listCalls[1]).toBe('parent');
  });

  // ========================================================================
  // H.3: rejects symlink cleanupDir pointing outside this.dir
  // ========================================================================

  it('H.3: rejects symlink cleanupDir pointing outside this.dir and audits traversal', async () => {
    const baseFs = new NodeFileSystem({ baseDir: tmpDir });
    const fs = Object.create(baseFs);
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snap-outside-'));
    const symlinkDir = path.join(tmpDir, 'symlink-cleanup');
    await fsp.symlink(outsideDir, symlinkDir, 'dir');

    // Place a marker in outside dir to verify it is NOT deleted
    await fsp.writeFile(path.join(outsideDir, 'marker.txt'), 'do-not-delete');

    // Mock realpath to return the outside dir (simulate resolved symlink target)
    // so snapshot.ts boundary check (not NodeFileSystem resolveAndCheck) catches it.
    fs.realpath = vi.fn().mockResolvedValue(outsideDir);

    const audit = makeMockAudit();
    const snapshot = new Snapshot(tmpDir, fs, audit, [], [symlinkDir]);
    await snapshot.init();

    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    const result = await snapshot.commit('test-h3');
    expect(result.ok).toBe(true);

    // outside dir must remain intact
    expect(fsSync.existsSync(path.join(outsideDir, 'marker.txt'))).toBe(true);

    // audit should contain symlink_traversal context
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SYNC_CLEAN_FAILED,
      expect.stringContaining('dir='),
      expect.stringContaining('context=symlink_traversal'),
      expect.stringContaining('cleanupDir='),
      expect.stringContaining('resolved='),
    );

    await fsp.rm(outsideDir, { recursive: true, force: true });
  });
});
