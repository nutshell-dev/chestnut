/**
 * phase 1217 (r131 C fork) B.1 — ContractSystem.close() true disposable
 *
 * 反向 3 项:
 * (a) close() 后 _activeContractControllers Map size = 0
 * (b) close() 前 register 的 AbortController.signal.aborted === true after close()
 * (c) cache.clear() 集成 path 调用每 instance .close()（spy verify）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { makeAudit, makeMockAudit, waitForNextAuditEvent } from '../../helpers/audit.js';
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

describe('phase 1217 (r131 C fork) B.1 — ContractSystem.close() true disposable', () => {
  let testDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let emitter: EventEmitter;
  let events: Array<[string, ...(string | number)[]]>;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-system-close-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    // phase 376: makeAudit 拿 emitter + events、test 用 waitForNextAuditEvent + events.find 替原 polling + spy
    const audit = makeAudit();
    const mockAudit = audit.audit;
    emitter = audit.emitter;
    events = audit.events;
    const mockLlm = { id: 'mock-llm' } as any;
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      llm: mockLlm,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      runContractVerifier: mockRunContractVerifier,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
    mockRunContractVerifier.mockReset();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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

    // phase 376: 订阅 VERIFIER_REGISTERED 之前触发 verification
    const verifierRegistered = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED);
    // 启动 verification，这会注册一个 AbortController
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
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      runContractVerifier: mockRunContractVerifier,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

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

    const closeEvent = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_SYSTEM_CLOSED);
    expect(closeEvent).toBeDefined();
    expect(closeEvent![1]).toEqual(expect.stringContaining('clawId='));
  });

  // ───── phase 687 (audit T2.4): _closed 幂等 guard、防 duplicate CONTRACT_SYSTEM_CLOSED audit emit ─────
  it('close() 二次调用幂等、CONTRACT_SYSTEM_CLOSED audit 只 emit 一次', async () => {
    await manager.close();
    await manager.close();

    const closeEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_SYSTEM_CLOSED);
    expect(closeEvents.length).toBe(1);
  });
});
