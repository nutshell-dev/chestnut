import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  createTrackedTempDir,
  createTrackedTempDirSync,
  cleanupAllTrackedDirs,
  cleanupTempDir,
  cleanupTempDirSync,
  getTrackedDirs,
  untrackTempDir,
} from './temp.js';

describe('temp.ts tracked temp dir API', () => {
  beforeEach(() => {
    // Ensure no leftover tracked dirs from previous test runs in the same worker.
    for (const dir of getTrackedDirs()) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanupAllTrackedDirs().catch(() => { /* ignore */ });
  });

  afterEach(async () => {
    await cleanupAllTrackedDirs().catch(() => { /* ignore */ });
  });

  it('createTrackedTempDir registers the directory', async () => {
    const dir = await createTrackedTempDir('tracked-async-');
    expect(fs.existsSync(dir)).toBe(true);
    expect(getTrackedDirs().has(dir)).toBe(true);
  });

  it('createTrackedTempDirSync registers the directory', () => {
    const dir = createTrackedTempDirSync('tracked-sync-');
    expect(fs.existsSync(dir)).toBe(true);
    expect(getTrackedDirs().has(dir)).toBe(true);
  });

  it('cleanupTempDir removes directory and untracks', async () => {
    const dir = await createTrackedTempDir('tracked-cleanup-');
    await cleanupTempDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(getTrackedDirs().has(dir)).toBe(false);
  });

  it('cleanupTempDirSync removes directory and untracks', () => {
    const dir = createTrackedTempDirSync('tracked-cleanup-sync-');
    cleanupTempDirSync(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(getTrackedDirs().has(dir)).toBe(false);
  });

  it('untrackTempDir removes from tracked set without deleting dir', async () => {
    const dir = await createTrackedTempDir('tracked-untrack-');
    untrackTempDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(getTrackedDirs().has(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cleanupAllTrackedDirs removes all tracked directories', async () => {
    const dir1 = await createTrackedTempDir('tracked-batch-1-');
    const dir2 = createTrackedTempDirSync('tracked-batch-2-');
    await cleanupAllTrackedDirs();
    expect(fs.existsSync(dir1)).toBe(false);
    expect(fs.existsSync(dir2)).toBe(false);
    expect(getTrackedDirs().size).toBe(0);
  });

  it('cleanupTempDir ignores ENOENT and untracks', async () => {
    const dir = await createTrackedTempDir('tracked-enoent-');
    fs.rmSync(dir, { recursive: true, force: true });
    await cleanupTempDir(dir);
    expect(getTrackedDirs().has(dir)).toBe(false);
  });

  it('cleanupTempDir ignores EINVAL and untracks', async () => {
    const dir = await createTrackedTempDir('tracked-einval-');
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(Object.assign(new Error('EINVAL'), { code: 'EINVAL' }));
    await cleanupTempDir(dir);
    expect(getTrackedDirs().has(dir)).toBe(false);
  });
});
