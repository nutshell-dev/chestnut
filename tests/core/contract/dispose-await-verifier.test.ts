/**
 * @module tests/core/contract/dispose-await-verifier
 * Phase 1335 sub-3: ContractSystem.close() async + await verifier termination
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeMockAudit } from '../../helpers/audit.js';

/**
 * Mock cs1.close 慢 dispose 时长 (10ms): 与 cs2 5ms 形成 close 顺序 race.
 * Derivation: 2 × MOCK_CS2_CLOSE_MS 保 cs1 严格 > cs2 / 序断言依赖此差值.
 */
const MOCK_CS1_CLOSE_MS = 10;

/**
 * Mock cs2.close 较快 dispose 时长 (5ms).
 * Derivation: < MOCK_CS1_CLOSE_MS / 给 closeOrder 排列 race 端口.
 */
const MOCK_CS2_CLOSE_MS = 5;

const { mockRunContractVerifier } = vi.hoisted(() => ({
  mockRunContractVerifier: vi.fn(),
}));

vi.mock('../../../src/core/contract/verifier-job.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/contract/verifier-job.js')>();
  return {
    ...mod,
    runContractVerifier: mockRunContractVerifier,
  };
});

describe('ContractSystem.close() async await verifier termination', () => {
  let testDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-dispose-async-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = makeMockAudit();
    const mockLlm = { id: 'mock-llm' } as any;
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      llm: mockLlm,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
    mockRunContractVerifier.mockReset();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('close() await 完成前 verifier subagent abort 真停', async () => {
    const contractId = await manager.create({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
    });

    await fs.mkdir(path.join(clawDir, 'contract/active', contractId, 'verification'), { recursive: true });
    await fs.writeFile(
      path.join(clawDir, 'contract/active', contractId, 'verification', 't1.prompt.txt'),
      'Check: {{evidence}}',
    );

    let resolveVerifier: (() => void) | undefined;
    let aborted = false;

    mockRunContractVerifier.mockImplementation(async (config: { signal?: AbortSignal }) => {
      config.signal?.addEventListener('abort', () => {
        aborted = true;
      }, { once: true });
      return new Promise((resolve) => {
        resolveVerifier = () => resolve({ passed: true, feedback: 'ok' });
      });
    });

    (manager as any).runLLMVerification(
      'verification/t1.prompt.txt',
      path.join(clawDir, 'contract/active', contractId),
      contractId,
      't1',
      'T1',
      'evidence',
      [],
    ).catch(() => {});

    await vi.waitFor(
      () => expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1),
      { timeout: 5000, interval: 10 },
    );

    const closePromise = manager.close();
    expect(aborted).toBe(true);
    expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1);

    resolveVerifier!();
    await closePromise;

    expect(manager.getActiveVerifierCount()).toBe(0);
  });

  it('disposeContractSystems 顺序：await close 完成才遍历完', async () => {
    const closeOrder: string[] = [];
    const cs1 = manager;
    const cs2 = new ContractSystem({
      clawDir,
      clawId: 'test-claw-2',
      fs: nodeFs,
      audit: makeMockAudit() as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    vi.spyOn(cs1, 'close').mockImplementation(async () => {
      closeOrder.push('cs1-start');
      await new Promise(r => setTimeout(r, MOCK_CS1_CLOSE_MS));
      closeOrder.push('cs1-end');
    });
    vi.spyOn(cs2, 'close').mockImplementation(async () => {
      closeOrder.push('cs2-start');
      await new Promise(r => setTimeout(r, MOCK_CS2_CLOSE_MS));
      closeOrder.push('cs2-end');
    });

    const cache = new Map<string, ContractSystem>();
    cache.set('claw-1', cs1);
    cache.set('claw-2', cs2);

    for (const cs of cache.values()) {
      await cs.close();
    }
    cache.clear();

    expect(closeOrder).toEqual(['cs1-start', 'cs1-end', 'cs2-start', 'cs2-end']);
  });
});
