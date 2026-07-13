/**
 * @module tests/core/contract/get-latest-contract-stats
 * Phase 832 Step A: getLatestContractStats lightweight query
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getLatestContractStats } from '../../../src/core/contract/lightweight-query.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('getLatestContractStats', () => {
  let testDir: string;
  let clawDir: string;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-latest-stats-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns null when no active or archived contract exists', () => {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    expect(getLatestContractStats(nodeFs, '.')).toBeNull();
  });

  it('returns active contract title with zeroed stats when active contract exists', async () => {
    const activeDir = path.join(clawDir, 'contract', 'active', 'ct-1');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, 'contract.yaml'), 'title: Active Contract\n');

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const stats = getLatestContractStats(nodeFs, '.');

    expect(stats).toEqual({
      title: 'Active Contract',
      total: 0,
      passed: 0,
      forceAccepted: 0,
      abandoned: 0,
    });
  });

  it('computes stats from the most recent archived contract', async () => {
    const archiveDir = path.join(clawDir, 'contract', 'archive');
    const oldDir = path.join(archiveDir, 'old');
    const newDir = path.join(archiveDir, 'new');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(newDir, { recursive: true });

    await fs.writeFile(path.join(oldDir, 'contract.yaml'), 'title: Old Contract\n');
    await fs.writeFile(
      path.join(oldDir, 'progress.json'),
      JSON.stringify({ schema_version: 1, subtasks: {} }),
    );

    await fs.writeFile(path.join(newDir, 'contract.yaml'), 'title: New Contract\n');
    await fs.writeFile(
      path.join(newDir, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        subtasks: {
          a: { status: 'completed' },
          b: { status: 'completed', force_accepted: true },
          c: { status: 'pending' },
        },
      }),
    );

    // Ensure newDir has a later mtime by touching it after oldDir.
    const now = Date.now();
    await fs.utimes(path.join(oldDir, 'contract.yaml'), now / 1000 - 10, now / 1000 - 10);
    await fs.utimes(path.join(newDir, 'contract.yaml'), now / 1000, now / 1000);

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const stats = getLatestContractStats(nodeFs, '.');

    expect(stats).toEqual({
      title: 'New Contract',
      total: 3,
      passed: 1,
      forceAccepted: 1,
      abandoned: 1,
    });
  });

  it('returns zeroed stats when archived contract has no progress subtasks', async () => {
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'contract.yaml'), 'title: Empty Contract\n');
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ schema_version: 1, subtasks: {} }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const stats = getLatestContractStats(nodeFs, '.');

    expect(stats).toEqual({
      title: 'Empty Contract',
      total: 0,
      passed: 0,
      forceAccepted: 0,
      abandoned: 0,
    });
  });

  it('prefers active contract over archived contract', async () => {
    const activeDir = path.join(clawDir, 'contract', 'active', 'ct-active');
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'ct-archive');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.mkdir(archiveDir, { recursive: true });

    await fs.writeFile(path.join(activeDir, 'contract.yaml'), 'title: Active Contract\n');
    await fs.writeFile(path.join(archiveDir, 'contract.yaml'), 'title: Archived Contract\n');
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ schema_version: 1, subtasks: { a: { status: 'completed' } } }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const stats = getLatestContractStats(nodeFs, '.');

    expect(stats?.title).toBe('Active Contract');
    expect(stats?.total).toBe(0);
  });
});
