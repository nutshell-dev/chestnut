/**
 * lockContract atomic helper tests (phase 1362)
 *
 * Covers TOCTOU race protection between contractDir() and acquireLock().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { lockContract } from '../../../src/core/contract/lock.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

let tmpDir: string;
let nodeFs: NodeFileSystem;
let mockAudit: { write: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-lock-contract-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  mockAudit = makeMockAudit();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('lockContract (phase 1362)', () => {
  it('happy path: contractDir return dir → acquireLock → re-verify same → return helper', async () => {
    const contractDirFn = vi.fn().mockResolvedValue('active');
    const ctx = { fs: nodeFs, audit: mockAudit as any };

    const result = await lockContract(ctx, 'c1', contractDirFn);

    expect(result.dir).toBe('active');
    expect(result.lockPath).toBe('active/c1/progress.lock');
    expect(typeof result.release).toBe('function');
    expect(contractDirFn).toHaveBeenCalledTimes(2); // before + re-verify
    expect(contractDirFn).toHaveBeenCalledWith('c1');

    const raceRetryCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY
    );
    expect(raceRetryCalls).toHaveLength(0);
  });

  it('race simulate: contractDir returns active → external move → re-verify paused → release + retry', async () => {
    await fs.mkdir(path.join(tmpDir, 'active', 'c1'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'paused', 'c1'), { recursive: true });

    let callCount = 0;
    const dirs = ['active', 'paused', 'paused', 'paused'];
    const contractDirFn = vi.fn().mockImplementation(() => {
      return Promise.resolve(dirs[callCount++]);
    });
    const ctx = { fs: nodeFs, audit: mockAudit as any };

    const result = await lockContract(ctx, 'c1', contractDirFn);

    expect(result.dir).toBe('paused');
    expect(contractDirFn).toHaveBeenCalledTimes(4);

    const raceRetryCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY
    );
    expect(raceRetryCalls).toHaveLength(1);
    expect(raceRetryCalls[0]).toContain('attempt=0');
    expect(raceRetryCalls[0]).toContain('dirBefore=active');
    expect(raceRetryCalls[0]).toContain('dirAfter=paused');
  });

  it('race max retry exhausted: contractDir flips 5+ times → throw exhausted', async () => {
    const dirs = ['a', 'b'];
    for (const d of dirs) {
      await fs.mkdir(path.join(tmpDir, d, 'c1'), { recursive: true });
    }

    let callCount = 0;
    const contractDirFn = vi.fn().mockImplementation(() => {
      // alternate a, b, a, b, ... so before !== after every time
      return Promise.resolve(dirs[callCount++ % dirs.length]);
    });
    const ctx = { fs: nodeFs, audit: mockAudit as any };

    await expect(lockContract(ctx, 'c1', contractDirFn)).rejects.toThrow(
      'TOCTOU race retry exhausted'
    );

    const raceRetryCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY
    );
    // 5 retry emits + 1 exhausted emit
    expect(raceRetryCalls).toHaveLength(6);
    const exhaustedCall = raceRetryCalls[raceRetryCalls.length - 1];
    expect(exhaustedCall).toContain('result=exhausted');
  });
});
