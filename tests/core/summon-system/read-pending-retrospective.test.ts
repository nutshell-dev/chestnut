/**
 * @module tests/core/summon-system/read-pending-retrospective
 * Phase 1349 sub-2: readPendingRetrospective split-API reverse tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readPendingRetrospective, InvalidJSONError, UnexpectedFormatError } from '../../../src/core/summon-system/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('readPendingRetrospective', () => {
  let testDir: string;
  let motionDir: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-read-pending-retro-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    motionDir = path.join(testDir, 'motion');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(motionDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('throws InvalidJSONError on malformed JSON', async () => {
    const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'c1.json'), 'not-json{{{');

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    await expect(readPendingRetrospective({ fs: nodeFs, contractId: 'c1' })).rejects.toThrow(InvalidJSONError);
  });

  it('throws UnexpectedFormatError on non-object JSON', async () => {
    const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'c1.json'), '"just a string"');

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    await expect(readPendingRetrospective({ fs: nodeFs, contractId: 'c1' })).rejects.toThrow(UnexpectedFormatError);
  });

  it('propagates ENOENT when file missing', async () => {
    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    await expect(readPendingRetrospective({ fs: nodeFs, contractId: 'missing' })).rejects.toThrow();
  });

  it('returns PendingRetroRef for valid object JSON', async () => {
    const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'c1.json'),
      JSON.stringify({ contractId: 'c1', targetClaw: 'claw-a', mode: 'mining', miningTaskId: 't1', createdAt: '2024-01-01T00:00:00Z' }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const result = await readPendingRetrospective({ fs: nodeFs, contractId: 'c1' });

    expect(result.contractId).toBe('c1');
    expect(result.targetClaw).toBe('claw-a');
    expect(result.mode).toBe('mining');
    expect(result.miningTaskId).toBe('t1');
  });
});
