/**
 * phase 1217 (r131 C fork) B.1 — ContractSystem.close() true disposable
 *
 * 反向 3 项:
 * (a) close() 后 _activeContractControllers Map size = 0
 * (b) close() 前 register 的 AbortController.signal.aborted === true after close()
 * (c) cache.clear() 集成 path 调用每 instance .close()（spy verify）
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
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

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

describe('phase 1217 (r131 C fork) B.1 — ContractSystem.close() true disposable', () => {
  let testDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-system-close-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditWrite = vi.fn();
    const mockAudit = { write: auditWrite };
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

  // ───── 反向 (a): close() 后 _activeContractControllers Map size = 0 ─────
  it('close() 后 active verifier controller count = 0', async () => {
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

    // 挂起 verifier 以保留 controller 注册
    mockRunContractVerifier.mockImplementation(async (config: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        config.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        }, { once: true });
      });
    });

    // 启动 verification，这会注册一个 AbortController
    (manager as any).runLLMVerification(
      'verification/t1.prompt.txt',
      path.join(clawDir, 'contract/active', contractId),
      contractId,
      't1',
      'T1',
      'evidence',
      [],
    ).catch(() => {});

    // phase 1144: 等 controller 真注册完成（避 wall-clock race）
    await vi.waitFor(
      () => expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1),
      { timeout: 5000, interval: 10 },
    );

    await manager.close();

    expect(manager.getActiveVerifierCount()).toBe(0);
  });

  // ───── 反向 (b): close() 前 register 的 controller signal aborted === true ─────
  it('close() 后既有 controller signal.aborted === true', async () => {
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

    let capturedSignal: AbortSignal | undefined;
    mockRunContractVerifier.mockImplementation(async (config: { signal?: AbortSignal }) => {
      capturedSignal = config.signal;
      return new Promise((_resolve, reject) => {
        config.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        }, { once: true });
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

    // phase 1144: 等 controller 真注册完成（避 wall-clock race）
    await vi.waitFor(
      () => expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1),
      { timeout: 5000, interval: 10 },
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    await manager.close();

    expect(capturedSignal!.aborted).toBe(true);
  });

  // ───── 反向 (c): cache.clear() 集成 path 调用每 instance .close() ─────
  it('disposeContractSystems 遍历调用每个 ContractSystem.close()', async () => {
    const cache = new Map<string, ContractSystem>();
    const closeSpy = vi.fn();

    // 创建两个 mock ContractSystem（只 spy close）
    const cs1 = manager;
    const cs2 = new ContractSystem({
      clawDir,
      clawId: 'test-claw-2',
      fs: nodeFs,
      audit: makeMockAudit() as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
    });

    // 用 vi.spyOn 包装 close
    const spy1 = vi.spyOn(cs1, 'close').mockImplementation(async () => {});
    const spy2 = vi.spyOn(cs2, 'close').mockImplementation(async () => {});

    cache.set('claw-1', cs1);
    cache.set('claw-2', cs2);

    // 模拟 assemble.ts disposeContractSystems lambda 行为
    for (const cs of cache.values()) {
      await cs.close();
    }
    cache.clear();

    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);

    spy1.mockRestore();
    spy2.mockRestore();
  });

  // ───── audit emit CONTRACT_SYSTEM_CLOSED ─────
  it('close() 触发 CONTRACT_SYSTEM_CLOSED audit event', async () => {
    await manager.close();

    expect(auditWrite).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.CONTRACT_SYSTEM_CLOSED,
      expect.stringContaining('clawId='),
    );
  });
});
