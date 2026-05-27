/**
 * phase 1020 / r124 C fork — cancel propagation 装配端真实施
 *
 * 反向 3 项:
 * 1. cancel 真 propagate verifier subagent abort
 * 2. verifier 完成后 controller 自动 unregister（cleanup invariant）
 * 3. 同 contract 多 verifier 并发，cancel abort 全部
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';

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

describe('phase 1020 / r124 C fork — cancel propagation 装配端真实施', () => {
  let testDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-cancel-prop-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
    });
    mockRunContractVerifier.mockReset();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  // ───── 反向 1: cancel 真 propagate verifier subagent abort ─────
  describe('反向 1: cancel 真 propagate verifier subagent abort', () => {
    it('cancelContract 触发后 active verifier signal aborted', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
      }));

      await fs.mkdir(path.join(clawDir, 'contract/active', contractId, 'verification'), { recursive: true });
      await fs.writeFile(
        path.join(clawDir, 'contract/active', contractId, 'verification', 't1.prompt.txt'),
        'Check: {{evidence}}',
      );

      mockRunContractVerifier.mockImplementation(async (config: { signal?: AbortSignal }) => {
        return new Promise((_, reject) => {
          const onAbort = () => reject(new Error('AbortError: signal aborted'));
          if (config.signal?.aborted) {
            onAbort();
            return;
          }
          config.signal?.addEventListener('abort', onAbort);
        });
      });

      const verifierPromise = (manager as any).runLLMVerification(
        'verification/t1.prompt.txt',
        path.join(clawDir, 'contract/active', contractId),
        contractId,
        't1',
        'T1',
        'evidence',
        [],
      );

      // phase 1144: 等 controller 真注册完成（避 wall-clock race）
      await vi.waitFor(
        () => expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1),
        { timeout: 5000, interval: 10 },
      );

      await manager.cancel(contractId, 'test reason');

      const result = await verifierPromise;
      expect(result.passed).toBe(false);
      expect(result.feedback).toContain('AbortError');
    });
  });

  // ───── 反向 2: cleanup invariant — verifier 完成后 controller 自动 unregister ─────
  describe('反向 2: cleanup invariant — verifier 完成后 controller 自动 unregister', () => {
    it('verifier resolve 后 _activeContractControllers Map 不 leak', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
      }));

      await fs.mkdir(path.join(clawDir, 'contract/active', contractId, 'verification'), { recursive: true });
      await fs.writeFile(
        path.join(clawDir, 'contract/active', contractId, 'verification', 't1.prompt.txt'),
        'Check: {{evidence}}',
      );

      let resolveVerifier!: (value: { passed: boolean; feedback: string }) => void;
      mockRunContractVerifier.mockImplementation(async () => {
        return new Promise((resolve) => {
          resolveVerifier = resolve;
        });
      });

      const promise = (manager as any).runLLMVerification(
        'verification/t1.prompt.txt',
        path.join(clawDir, 'contract/active', contractId),
        contractId,
        't1',
        'T1',
        'evidence',
        [],
      );

      // phase 1144: 等 controller 真注册完成（避 wall-clock race）
      await vi.waitFor(
        () => expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1),
        { timeout: 5000, interval: 10 },
      );

      const controllers = (manager as any)._activeContractControllers;
      expect(controllers.get(contractId)).toBeDefined();
      expect(controllers.get(contractId).size).toBe(1);

      // 让 verifier 完成
      resolveVerifier({ passed: true, feedback: 'ok' });
      await promise;

      // finally unregister 后 Map 应清空
      expect(controllers.get(contractId)).toBeUndefined();
    });
  });

  // ───── 反向 3: multi-verifier same contract — 1 cancel abort 全部 controller ─────
  describe('反向 3: multi-verifier same contract — 1 cancel abort 全部', () => {
    it('同 contractId 2 并发 verifier、1 cancel abort 全部', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [
          { id: 't1', description: 'T1' },
          { id: 't2', description: 'T2' },
        ],
        verification: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
          { subtask_id: 't2', type: 'llm', prompt_file: 'verification/t2.prompt.txt' },
        ],
      }));

      await fs.mkdir(path.join(clawDir, 'contract/active', contractId, 'verification'), { recursive: true });
      await fs.writeFile(
        path.join(clawDir, 'contract/active', contractId, 'verification', 't1.prompt.txt'),
        'Check: {{evidence}}',
      );
      await fs.writeFile(
        path.join(clawDir, 'contract/active', contractId, 'verification', 't2.prompt.txt'),
        'Check: {{evidence}}',
      );

      mockRunContractVerifier.mockImplementation(async (config: { signal?: AbortSignal }) => {
        return new Promise((_, reject) => {
          const onAbort = () => reject(new Error('AbortError: signal aborted'));
          if (config.signal?.aborted) {
            onAbort();
            return;
          }
          config.signal?.addEventListener('abort', onAbort);
        });
      });

      const p1 = (manager as any).runLLMVerification(
        'verification/t1.prompt.txt',
        path.join(clawDir, 'contract/active', contractId),
        contractId,
        't1',
        'T1',
        'evidence',
        [],
      );
      const p2 = (manager as any).runLLMVerification(
        'verification/t2.prompt.txt',
        path.join(clawDir, 'contract/active', contractId),
        contractId,
        't2',
        'T2',
        'evidence',
        [],
      );

      // phase 1144: 等 2 个 controller 都注册完成（避 wall-clock race + N=1 时 cancel race）
      await vi.waitFor(
        () => expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(2),
        { timeout: 5000, interval: 10 },
      );

      await manager.cancel(contractId, 'test');

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.passed).toBe(false);
      expect(r1.feedback).toContain('AbortError');
      expect(r2.passed).toBe(false);
      expect(r2.feedback).toContain('AbortError');
    });
  });
});
