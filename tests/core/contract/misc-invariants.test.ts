/**
 * Merged misc-invariants test file (mechanical merge; assertion logic unchanged).
 *
 * Sources:
 * - contract-auditor-close.test.ts
 * - maybe-audit-step-load-active-failed-audit.test.ts
 * - contract-id-derive.test.ts
 * - discovery.test.ts
 * - utils-fs-not-found-narrow.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { ContractAuditor } from '../../../src/core/contract/contract-auditor.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { loadAllActiveContracts, loadActiveContract } from '../../../src/core/contract/discovery.js';
import { MultipleActiveContractsError } from '../../../src/core/contract/errors.js';
import { getActiveContractTimestamp } from '../../../src/core/contract/lightweight-query.js';
import { makeClawId } from '../../../src/foundation/claw-identity/index.js';
import { FileNotFoundError, type FileSystem } from '../../../src/foundation/fs/types.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeMockAudit, makeAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { waitFor } from '../../helpers/wait-for.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { LLMOrchestrator, LLMResponse } from '../../../src/foundation/llm-orchestrator/index.js';
import type { InboxWriter } from '../../../src/foundation/messaging/index.js';

/**
 * phase 517 B3 regression:
 * ContractAuditor.close must abort in-flight LLM call and wait for inflight settle.
 * Previously: callAuditorLLM had no signal; SIGTERM left auditor LLM call hanging.
 */
describe('ContractAuditor.close (phase 517 B3)', () => {
  function makeAuditMock(): AuditLog {
    return {
      write: vi.fn(),
      message: vi.fn((s: string) => s),
      dispose: vi.fn(),
    } as unknown as AuditLog;
  }

  function makeFsMock(): FileSystem {
    return {
      list: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue(''),
    } as unknown as FileSystem;
  }

  function makeInboxMock(): InboxWriter {
    return {
      write: vi.fn().mockResolvedValue(undefined),
    } as unknown as InboxWriter;
  }

  function makeAuditRequest() {
    return {
      contractId: 'c1',
      contractTitle: 'test contract',
      clawId: makeClawId('test-claw'),
      currentStep: 10,
      auditInterval: 5,
      lastAuditedStep: 0,
      expectations: 'do the thing',
      contractStartedAt: new Date().toISOString(),
      progress: { done: [], in_progress: null, pending: [] },
      recentMessages: undefined,
    };
  }

  it('aborts in-flight LLM call and resolves close after inflight settles', async () => {
    let receivedSignal: AbortSignal | undefined;
    const llm = {
      call: vi.fn(async (opts: { signal?: AbortSignal }) => {
        receivedSignal = opts.signal;
        // wait until aborted
        return new Promise<LLMResponse>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
      stream: vi.fn(),
      close: vi.fn(),
      reloadConfig: vi.fn(),
    } as unknown as LLMOrchestrator;

    const auditor = new ContractAuditor({
      audit: makeAuditMock(),
      fs: makeFsMock(),
      inbox: makeInboxMock(),
      llm,
      inboxPendingDir: '/tmp/inbox-pending-test',
    });

    // kick off audit (fire-and-forget pattern matches manager.ts:312)
    const auditPromise = auditor.maybeAudit(makeAuditRequest());

    // phase 789: waitFor poll until llm.call begins and the abort signal is received
    await waitFor(() => receivedSignal !== undefined, 5000);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    // close should abort + wait for settle
    await auditor.close();

    expect(receivedSignal!.aborted).toBe(true);
    // audit promise should resolve to llm_call_failed
    const outcome = await auditPromise;
    expect(outcome.audited).toBe(false);
    expect(outcome.reason).toContain('llm_call_failed');
  });

  it('refuses new maybeAudit after close', async () => {
    const llm = {
      call: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
      reloadConfig: vi.fn(),
    } as unknown as LLMOrchestrator;

    const auditor = new ContractAuditor({
      audit: makeAuditMock(),
      fs: makeFsMock(),
      inbox: makeInboxMock(),
      llm,
      inboxPendingDir: '/tmp/inbox-pending-test',
    });

    await auditor.close();
    const result = await auditor.maybeAudit(makeAuditRequest());
    expect(result.audited).toBe(false);
    expect(result.reason).toBe('auditor_closed');
    expect(llm.call).not.toHaveBeenCalled();
  });

  it('close is idempotent', async () => {
    const auditor = new ContractAuditor({
      audit: makeAuditMock(),
      fs: makeFsMock(),
      inbox: makeInboxMock(),
      llm: { call: vi.fn(), stream: vi.fn(), close: vi.fn(), reloadConfig: vi.fn() } as unknown as LLMOrchestrator,
      inboxPendingDir: '/tmp/inbox-pending-test',
    });

    await auditor.close();
    await auditor.close();  // second call should not throw
    await auditor.close();  // third call too
  });
});

/**
 * @module tests/core/contract/maybe-audit-step-load-active-failed-audit
 * Phase 160: maybeAuditStep loadActive silent catch audit emit (playbook §1)
 *
 * 反向 3 项：
 * 1. loadActive throws → emit AUDITOR_LOAD_ACTIVE_FAILED + 不抛
 * 2. loadActive returns null → 0 AUDITOR_LOAD_ACTIVE_FAILED audit
 * 3. loadActive returns contract → 正常路径 0 改
 */
describe('maybeAuditStep loadActive silent catch audit emit (phase 160)', () => {
  let testDir: string;
  let clawDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-maybe-audit-step-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.restoreAllMocks();
  });

  function makeManager() {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: { write: auditWrite, __brand: 'AuditLog' , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });
  }

  // 反向 1：loadActive throws → emit AUDITOR_LOAD_ACTIVE_FAILED + 不抛
  it('反向 1: loadActive throws → emit AUDITOR_LOAD_ACTIVE_FAILED + 不抛', async () => {
    const manager = makeManager();
    const mockAuditor = { maybeAudit: vi.fn().mockResolvedValue({ audited: true }) };
    manager.attachAuditor(mockAuditor as any);

    vi.spyOn(manager, 'loadActive').mockRejectedValue(new Error('EIO'));

    // act: 调 maybeAuditStep、应 resolve 不抛
    await expect(manager.maybeAuditStep(10)).resolves.toBeUndefined();

    // expect: emit AUDITOR_LOAD_ACTIVE_FAILED
    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.AUDITOR_LOAD_ACTIVE_FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall).toContainEqual('clawId=test-claw');
    expect(failedCall).toContainEqual('step=10');
    expect(failedCall).toContainEqual(expect.stringContaining('error='));

    // expect: auditor.maybeAudit 未调（因 catch 提前 return）
    expect(mockAuditor.maybeAudit).not.toHaveBeenCalled();
  });

  // 反向 2：loadActive returns null → 0 AUDITOR_LOAD_ACTIVE_FAILED audit
  it('反向 2: loadActive returns null → 0 AUDITOR_LOAD_ACTIVE_FAILED audit', async () => {
    const manager = makeManager();
    const mockAuditor = { maybeAudit: vi.fn().mockResolvedValue({ audited: true }) };
    manager.attachAuditor(mockAuditor as any);

    vi.spyOn(manager, 'loadActive').mockResolvedValue(null);

    await manager.maybeAuditStep(10);

    // expect: 不 emit AUDITOR_LOAD_ACTIVE_FAILED（既有 silent return path 不退化）
    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.AUDITOR_LOAD_ACTIVE_FAILED,
    );
    expect(failedCall).toBeUndefined();

    // expect: auditor.maybeAudit 未调（因无 active contract）
    expect(mockAuditor.maybeAudit).not.toHaveBeenCalled();
  });

  // 反向 3：loadActive returns contract → 正常路径 0 改
  it('反向 3: loadActive returns contract → 正常路径不动', async () => {
    const manager = makeManager();
    const mockAuditor = { maybeAudit: vi.fn().mockResolvedValue({ audited: true }) };
    manager.attachAuditor(mockAuditor as any);

    vi.spyOn(manager, 'loadActive').mockResolvedValue({
      id: 'c-1',
      title: 'Test Contract',
    } as any);
    vi.spyOn(manager, 'loadContractYaml').mockResolvedValue({
      title: 'Test Contract',
      goal: 'G',
      subtasks: [],
      audit_interval: 1,
      expectations: 'do it',
    } as any);
    vi.spyOn(manager, 'getProgress').mockResolvedValue({
      schema_version: 1,
      contract_id: 'c-1',
      status: 'active',
      subtasks: {},
      started_at: '2024-01-01T00:00:00Z',
    } as any);

    await manager.maybeAuditStep(10);

    // expect: 不 emit AUDITOR_LOAD_ACTIVE_FAILED
    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.AUDITOR_LOAD_ACTIVE_FAILED,
    );
    expect(failedCall).toBeUndefined();

    // expect: auditor.maybeAudit 被调（正常路径）
    expect(mockAuditor.maybeAudit).toHaveBeenCalledTimes(1);
    expect(mockAuditor.maybeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: 'c-1',
        clawId: 'test-claw',
        currentStep: 10,
      }),
    );
  });
});

/**
 * Phase 282 Step B: contract_id derive from caller/dir
 */
describe('contract_id derive (phase 282 Step B)', () => {
  let tmpDir: string;
  let clawDir: string;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `.test-phase282-b-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('loadProgress returns ProgressData with contract_id from caller', async () => {
    const mockAudit = makeMockAudit();
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const progress = await manager.getProgress(contractId);
    expect(progress).not.toBeNull();
    expect(progress!.contract_id).toBe(contractId);
  });

  it('legacy contract_id field in JSON → migration emit + ignored', async () => {
    const mockAudit = makeMockAudit();
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // overwrite with legacy contract_id field
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(progressPath, JSON.stringify({
      schema_version: 1,
      contract_id: 'legacy-id',
      subtasks: { t1: { status: 'todo' } },
    }), 'utf-8');

    const progress = await manager.getProgress(contractId);
    expect(progress).not.toBeNull();
    // contract_id derived from caller, legacy value ignored
    expect(progress!.contract_id).toBe(contractId);

    const legacyCalls = (mockAudit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_CONTRACT_ID_FIELD_IGNORED,
    );
    expect(legacyCalls.length).toBeGreaterThanOrEqual(1);
    expect(legacyCalls[0]).toContainEqual(expect.stringContaining('legacy_contract_id=legacy-id'));
  });

  it('saveProgress does not write contract_id field', async () => {
    const mockAudit = makeMockAudit();
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    const saved = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
    expect(saved).not.toHaveProperty('contract_id');
  });
});

/**
 * Contract discovery tests (phase 956)
 *
 * - loadAllActiveContracts returns all active contracts and audits when multiple found
 */
describe('Contract discovery (phase 956)', () => {
  let tmpDir: string;
  let clawDir: string;
  let activeDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-discovery-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    activeDir = path.join(clawDir, 'contract', 'active');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(activeDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  async function writeContractDir(contractId: string, startedAt: string) {
    const dir = path.join(activeDir, contractId);
    await fs.mkdir(dir, { recursive: true });
    const progress = {
      schema_version: 1,
      subtasks: { 'task-1': { status: 'todo' } },
      started_at: startedAt,
      checkpoint: null,
    };
    await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify(progress), 'utf-8');
  }

  it('returns all active contracts and audits when multiple found', async () => {
    const { audit, events, emitter } = makeAudit();
    const ctx = {
      fs: nodeFs,
      audit,
      loadContract: vi.fn(async (id: string) => ({ id } as any)),
    };

    await writeContractDir('c1', '2026-07-12T10:00:00.000Z');
    await writeContractDir('c2', '2026-07-12T11:00:00.000Z');

    const all = await loadAllActiveContracts(ctx, 'contract/active');

    expect(all.length).toBe(2);
    expect(all.map((e) => e.name).sort()).toEqual(['c1', 'c2']);

    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS);
    const event = events.find((e) => e[0] === CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS);
    expect(event).toBeDefined();
    expect(event!.some((col) => typeof col === 'string' && col.startsWith('count=2'))).toBe(true);
    expect(event!.some((col) => typeof col === 'string' && col.includes('c1') && col.includes('c2'))).toBe(true);
  });

  it('returns single active contract without multi-active audit', async () => {
    const { audit, events } = makeAudit();
    const ctx = {
      fs: nodeFs,
      audit,
      loadContract: vi.fn(async (id: string) => ({ id } as any)),
    };

    await writeContractDir('c1', '2026-07-12T10:00:00.000Z');

    const all = await loadAllActiveContracts(ctx, 'contract/active');

    expect(all.length).toBe(1);
    expect(all[0].name).toBe('c1');
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS)).toBe(false);
  });

  it('throws MultipleActiveContractsError when multiple valid active contracts exist', async () => {
    const { audit, events, emitter } = makeAudit();
    const ctx = {
      fs: nodeFs,
      audit,
      loadContract: vi.fn(async (id: string) => ({ id } as any)),
    };

    await writeContractDir('c1', '2026-07-12T10:00:00.000Z');
    await writeContractDir('c2', '2026-07-12T11:00:00.000Z');

    await expect(loadActiveContract(ctx, 'contract/active')).rejects.toThrow(MultipleActiveContractsError);
    await expect(loadActiveContract(ctx, 'contract/active')).rejects.toThrow(/Found 2 active contracts/);

    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS);
    const event = events.find((e) => e[0] === CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS);
    expect(event).toBeDefined();
    expect(event!.some((col) => typeof col === 'string' && col.startsWith('count=2'))).toBe(true);
  });
});

/**
 * Phase 1154 α-1 — utils.ts getContractCreatedMs FS_NOT_FOUND narrow 反向测试
 *
 * 反向 4 项:
 *   (1) paused/ 不存在 silent：mock fs.listSync throw FileNotFoundError → audit 0 emit
 *   (2) 非 ENOENT 真 emit：mock fs.listSync throw Error{code: 'EACCES'} → audit emit CONTRACT_DIR_SCAN_FAILED 1 次
 *   (3) raw ENOENT 兼容：mock fs.listSync throw Error{code: 'ENOENT'} → audit 0 emit
 *   (4) happy path 不动：mock fs.listSync 返合法 entries → audit 0 emit + 返 first timestamp
 */
describe('phase 1154 — getActiveContractTimestamp FS_NOT_FOUND narrow', () => {
  it('silent for FileNotFoundError (FileSystem abstract layer)', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => { throw new FileNotFoundError('/tmp/claw/contract/active'); },
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = getActiveContractTimestamp(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('emits CONTRACT_DIR_SCAN_FAILED for EACCES', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = getActiveContractTimestamp(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    expect(events).toHaveLength(1); // active only
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED);
    expect(events[0]).toContain('code=EACCES');
  });

  it('silent for raw ENOENT (Node native)', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = getActiveContractTimestamp(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('happy path returns first timestamp and no audit', () => {
    const { audit, events } = makeAudit();
    const ts = Date.now();
    const fs = {
      listSync: () => [
        { name: `${ts}-contract1`, isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
        { name: `${ts + 1000}-contract2`, isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
      ],
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = getActiveContractTimestamp(fs, '/tmp/claw', audit);
    expect(result).toBe(ts);
    expect(events).toHaveLength(0);
  });
});
