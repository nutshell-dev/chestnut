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
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';

let tmpDir: string;
let nodeFs: NodeFileSystem;
let mockAudit: { write: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-lock-contract-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  mockAudit = makeMockAudit();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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

describe('manager.withProgressLock uses lockContract atomic (phase 1371 sub-1)', () => {
  it('acquires lock via lockContract TOCTOU re-verify (contractDir called twice)', async () => {
    const clawDir = tmpDir;
    const activeDir = path.join(clawDir, 'contract', 'active');
    const contractId = 'test-c1';
    const contractDir = path.join(activeDir, contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(
      path.join(contractDir, 'progress.json'),
      JSON.stringify({ schema_version: 1, contract_id: contractId, status: 'running', subtasks: {} }),
    );

    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractDirSpy = vi.spyOn(manager as any, 'contractDir');

    const result = await (manager as any).withProgressLock(contractId, async () => 'locked-value');

    expect(result).toBe('locked-value');
    // lockContract calls contractDirFn twice: before + after lock acquisition (TOCTOU re-verify)
    expect(contractDirSpy).toHaveBeenCalledTimes(2);
    expect(contractDirSpy).toHaveBeenCalledWith(contractId);

    // lock file should be released (deleted) after withProgressLock returns
    const lockPath = path.join(contractDir, 'progress.lock');
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});
