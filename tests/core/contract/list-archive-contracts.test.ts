/**
 * @module tests/core/contract/list-archive-contracts
 * Phase 1335 sub-4: listArchiveContracts cross-module query API
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { listArchiveContracts } from '../../../src/core/contract/persistence.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('listArchiveContracts', () => {
  let testDir: string;
  let clawforumDir: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-list-archive-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawforumDir = path.join(testDir, 'clawforum');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawforumDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns empty array when claws dir missing', async () => {
    const nodeFs = new NodeFileSystem({ baseDir: clawforumDir });
    const result = await listArchiveContracts({ fs: nodeFs });
    expect(result).toEqual([]);
  });

  it('lists archived contracts with clawId + contractId + contractDir', async () => {
    const archiveDir = path.join(clawforumDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ schema_version: 1, contract_id: 'ct-1', status: 'completed', subtasks: {}, completed_at: '2024-01-15T00:00:00Z' }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: clawforumDir });
    const result = await listArchiveContracts({ fs: nodeFs });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].contractDir).toBe('claws/c1/contract/archive/ct-1');
    expect(result[0].archivedAt).toBe('2024-01-15T00:00:00Z');
  });

  it('filters by sinceMs/untilMs', async () => {
    const archiveDir1 = path.join(clawforumDir, 'claws', 'c1', 'contract', 'archive', 'old');
    await fs.mkdir(archiveDir1, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir1, 'progress.json'),
      JSON.stringify({ completed_at: '2024-01-01T00:00:00Z' }),
    );

    const archiveDir2 = path.join(clawforumDir, 'claws', 'c1', 'contract', 'archive', 'new');
    await fs.mkdir(archiveDir2, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir2, 'progress.json'),
      JSON.stringify({ completed_at: '2024-06-01T00:00:00Z' }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: clawforumDir });
    const result = await listArchiveContracts({
      fs: nodeFs,
      filter: { sinceMs: new Date('2024-03-01').getTime() },
    });

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('new');
  });
});
