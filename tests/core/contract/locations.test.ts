/**
 * Contract location helpers tests
 *
 * Phase 1130 Step B: physical active directory enumeration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { listPhysicalActiveContractIds } from '../../../src/core/contract/locations.js';

describe('listPhysicalActiveContractIds', () => {
  let tmpDir: string;
  let fsNode: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = await createTempDir('chestnut-locations-');
    fsNode = new NodeFileSystem({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir).catch(() => { /* silent: cleanup */ });
  });

  it('returns empty array when active dir does not exist', async () => {
    const result = await listPhysicalActiveContractIds({
      fs: fsNode,
      activeDir: 'contract/active',
    });
    expect(result).toEqual([]);
  });

  it('returns only direct child directories, sorted', async () => {
    await fs.mkdir(path.join(tmpDir, 'contract', 'active', 'c-beta'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'contract', 'active', 'c-alpha'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'contract', 'active', 'c-gamma'), { recursive: true });

    const result = await listPhysicalActiveContractIds({
      fs: fsNode,
      activeDir: 'contract/active',
    });

    expect(result).toEqual(['c-alpha', 'c-beta', 'c-gamma']);
  });

  it('ignores plain files and nested directories', async () => {
    const activeDir = path.join(tmpDir, 'contract', 'active');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.mkdir(path.join(activeDir, 'c-real'), { recursive: true });
    await fs.writeFile(path.join(activeDir, 'not-a-dir.txt'), 'x');
    await fs.mkdir(path.join(activeDir, 'c-real', 'nested'), { recursive: true });

    const result = await listPhysicalActiveContractIds({
      fs: fsNode,
      activeDir: 'contract/active',
    });

    expect(result).toEqual(['c-real']);
  });

  it('returns directories without progress.json (corrupt or stray active entries)', async () => {
    const activeDir = path.join(tmpDir, 'contract', 'active');
    await fs.mkdir(path.join(activeDir, 'c-no-progress'), { recursive: true });
    await fs.mkdir(path.join(activeDir, 'c-with-progress'), { recursive: true });
    await fs.writeFile(path.join(activeDir, 'c-with-progress', 'progress.json'), '{}');

    const result = await listPhysicalActiveContractIds({
      fs: fsNode,
      activeDir: 'contract/active',
    });

    expect(result).toEqual(['c-no-progress', 'c-with-progress']);
  });

  it('propagates list errors instead of treating them as empty', async () => {
    const brokenFs = {
      ...fsNode,
      exists: async () => true,
      list: async () => {
        throw new Error('disk read failed');
      },
    };

    await expect(
      listPhysicalActiveContractIds({
        fs: brokenFs as unknown as NodeFileSystem,
        activeDir: 'contract/active',
      }),
    ).rejects.toThrow('disk read failed');
  });
});
