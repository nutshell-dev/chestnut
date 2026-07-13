/**
 * LockContentionExhaustedError tests (phase 67 Step D)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { lockContract, LOCK_CONTRACT_MAX_RETRY } from '../../../src/core/contract/lock.js';
import { LockContentionExhaustedError } from '../../../src/core/contract/errors.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeMockAudit } from '../../helpers/audit.js';

let tmpDir: string;
let nodeFs: NodeFileSystem;
let mockAudit: { write: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-lock-contention-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  mockAudit = makeMockAudit();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

describe('LockContentionExhaustedError (phase 67)', () => {
  it('lock retry budget exhausted → throw typed Error', async () => {
    const dirs = ['a', 'b'];
    for (const d of dirs) {
      await fs.mkdir(path.join(tmpDir, d, 'c1'), { recursive: true });
    }

    let callCount = 0;
    const contractDirFn = vi.fn().mockImplementation(() => {
      return Promise.resolve(dirs[callCount++ % dirs.length]);
    });
    const ctx = { fs: nodeFs, audit: mockAudit as any };

    await expect(lockContract(ctx, 'c1', contractDirFn)).rejects.toThrow(LockContentionExhaustedError);
  });

  it('typed Error fields are correct', async () => {
    const dirs = ['a', 'b'];
    for (const d of dirs) {
      await fs.mkdir(path.join(tmpDir, d, 'c1'), { recursive: true });
    }

    let callCount = 0;
    const contractDirFn = vi.fn().mockImplementation(() => {
      return Promise.resolve(dirs[callCount++ % dirs.length]);
    });
    const ctx = { fs: nodeFs, audit: mockAudit as any };

    try {
      await lockContract(ctx, 'c1', contractDirFn);
    } catch (err) {
      expect(err).toBeInstanceOf(LockContentionExhaustedError);
      expect((err as LockContentionExhaustedError).contractId).toBe('c1');
      expect((err as LockContentionExhaustedError).attempts).toBe(LOCK_CONTRACT_MAX_RETRY);
      expect((err as LockContentionExhaustedError).message).toContain('TOCTOU race retry exhausted');
    }
  });
});
