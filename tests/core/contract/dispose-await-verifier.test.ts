/**
 * @module tests/core/contract/dispose-await-verifier
 * Phase 1335 sub-3: ContractSystem.close() async + await verifier termination
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeAudit, makeMockAudit, waitForNextAuditEvent } from '../../helpers/audit.js';
import { waitFor } from '../../helpers/wait-for.js';

/**
 * Promise barrier releases for ordered close() simulation.
 * cs1 must complete after cs2; release order is controlled explicitly below.
 */
let cs1Release: (() => void) | undefined;
let cs2Release: (() => void) | undefined;

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
  let emitter: EventEmitter;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-dispose-async-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    // phase 376: makeAudit 拿 emitter、test 用 waitForNextAuditEvent 替原 polling
    const { audit: mockAudit, emitter: em } = makeAudit();
    emitter = em;
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
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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

    // phase 376: 订阅 VERIFIER_REGISTERED 之前触发 verification
    const verifierRegistered = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED);
    (manager as any).runLLMVerification(
      'verification/t1.prompt.txt',
      path.join(clawDir, 'contract/active', contractId),
      contractId,
      't1',
      'T1',
      'evidence',
      [],
    ).catch(() => { /* silent: shutdown */ });

    await verifierRegistered;

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
      await new Promise<void>(r => { cs1Release = r; });
      closeOrder.push('cs1-end');
    });
    vi.spyOn(cs2, 'close').mockImplementation(async () => {
      closeOrder.push('cs2-start');
      await new Promise<void>(r => { cs2Release = r; });
      closeOrder.push('cs2-end');
    });

    const cache = new Map<string, ContractSystem>();
    cache.set('claw-1', cs1);
    cache.set('claw-2', cs2);

    const closePromise = (async () => {
      for (const cs of cache.values()) {
        await cs.close();
      }
      cache.clear();
    })();

    // cs1 is called first by the loop; release it so cs1-end is recorded and the loop proceeds to cs2.
    await waitFor(() => closeOrder.includes('cs1-start'), 1000);
    cs1Release!();

    // cs2 is now called; release it so cs2-end is recorded.
    await waitFor(() => closeOrder.includes('cs2-start'), 1000);
    cs2Release!();

    await closePromise;

    expect(closeOrder).toEqual(['cs1-start', 'cs1-end', 'cs2-start', 'cs2-end']);
  });
});
