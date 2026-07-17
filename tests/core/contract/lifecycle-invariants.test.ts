/**
 * ContractSystem lifecycle invariants — merged test file
 *
 * Sources:
 * - lifecycle.test.ts
 * - lifecycle-race.test.ts
 * - lifecycle-orphan-lock.test.ts
 * - mark-crashed.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { ToolError } from '../../../src/foundation/tools/errors.js';



// ───── source: lifecycle.test.ts ─────
/**
 * ContractSystem lifecycle tests (Phase 966)
 */
describe('ContractSystem lifecycle (Phase 966)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: { write: vi.fn(), preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('resets in_progress subtasks when cancelling contract (Phase 967)', async () => {
    const contractId = await manager.create({
      title: 'Cancel Test',
      goal: 'test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }],
      verification: [],
    });

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    const raw = await fs.readFile(progressPath, 'utf-8');
    const progress = JSON.parse(raw);
    progress.subtasks['task-1'].status = 'in_progress';
    progress.subtasks['task-1'].verification_attempt_id = 'attempt-1';
    await fs.writeFile(progressPath, JSON.stringify(progress, null, 2));

    await manager.cancel(contractId, 'test');

    const archivedProgressPath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBe('cancelled');
    expect(archivedProgress.subtasks['task-1'].status).toBe('todo');
    expect(archivedProgress.subtasks['task-1'].verification_attempt_id).toBeUndefined();
  });

  it('resets in_progress subtasks when marking contract crashed (Phase 967)', async () => {
    const contractId = await manager.create({
      title: 'Crash Test',
      goal: 'test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }],
      verification: [],
    });

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    const raw = await fs.readFile(progressPath, 'utf-8');
    const progress = JSON.parse(raw);
    progress.subtasks['task-1'].status = 'in_progress';
    progress.subtasks['task-1'].verification_attempt_id = 'attempt-1';
    await fs.writeFile(progressPath, JSON.stringify(progress, null, 2));

    await manager.markCrashed(contractId, 'test-crash');

    const archivedProgressPath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBe('crashed');
    expect(archivedProgress.subtasks['task-1'].status).toBe('todo');
    expect(archivedProgress.subtasks['task-1'].verification_attempt_id).toBeUndefined();
  });

  it('resets in_progress subtasks when resuming paused contract', async () => {
    const contractId = 'resume-in-progress';
    const pausedDir = path.join(clawDir, 'contract', 'paused', contractId);
    await fs.mkdir(pausedDir, { recursive: true });

    await fs.writeFile(
      path.join(pausedDir, 'contract.yaml'),
      yaml.dump(makeContractYaml({ id: contractId })),
    );
    await fs.writeFile(
      path.join(pausedDir, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        status: 'paused',
        subtasks: {
          'task-1': { status: 'in_progress', verification_attempt_id: 'old-attempt' },
        },
        started_at: new Date().toISOString(),
        checkpoint: 'paused checkpoint',
      }, null, 2),
    );

    await manager.resume(contractId);

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('running');
    expect(progress.checkpoint).toBeNull();
    expect(progress.subtasks['task-1'].status).toBe('todo');
    expect(progress.subtasks['task-1'].verification_attempt_id).toBeUndefined();

    // Verify the contract has moved back to active/
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    expect(await fs.stat(activeDir).then(() => true).catch(() => false)).toBe(true);
  });
});

// ───── source: lifecycle-race.test.ts ─────
/**
 * ContractSystem lifecycle race (phase 791 / P0.16 + P0.18)
 */
describe('ContractSystem lifecycle race (phase 791 / P0.16 + P0.18)', () => {
  /**
   * Promise barrier release for mock background verification.
   * Keeps verification in-flight until the test explicitly releases it.
   */
  let verificationRelease: (() => void) | undefined;

  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let auditCalls: Array<{ type: string; args: string[] }>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditCalls = [];
    const captureAudit = {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
      },
    };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('pause race: concurrent completeSubtask + pause no deadlock no data loss (P0.16)', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Race Test',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      verification: [],
    }));

    // 先完成一个子任务，确保数据存在
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    // 并发：同时 pause 和 completeSubtask
    const [pauseResult] = await Promise.allSettled([
      manager.pause(contractId, 'race-checkpoint'),
      manager.completeSubtask({ contractId, subtaskId: 't2', evidence: 'done too' }),
    ]);

    // pause 应该成功（或在 lock 竞争下失败但不死锁）
    expect(pauseResult.status).not.toBe('rejected');

    // 最终 contract 应在 paused/（如果 pause 赢了）或 active/（如果 pause 没赢）
    // 但关键是 status 和子任务数据没被损坏
    const progress = await manager.getProgress(contractId);
    // 子任务 t1 必须仍然是 completed
    expect(progress.subtasks['t1'].status).toBe('completed');
  });

  it('cancel race: concurrent verification background + cancel no progress overwrite (P0.18)', async () => {
    const contractId = 'cancel-race-contract';
    const subtaskId = 't1';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });

    const yaml = await import('js-yaml');
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      yaml.dump(makeContractYaml({
        title: 'Cancel Race Test',
        goal: 'Test',
        subtasks: [{ id: subtaskId, description: 'T1' }],
        verification: [{ subtask_id: subtaskId, type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
      }))
    );

    await fs.writeFile(
      path.join(contractDir, 'progress.json'),
      JSON.stringify({
        // phase 319: 加 schema_version 以匹配 Zod SoT strict 要求（mirror phase 311 ContractYaml strict pattern）
        schema_version: 1,
        contract_id: contractId,
        status: 'running',
        subtasks: {
          [subtaskId]: { status: 'todo', retry_count: 0 },
        },
        started_at: new Date().toISOString(),
        checkpoint: null,
      }, null, 2)
    );
    await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
    await fs.writeFile(path.join(contractDir, 'verification', 't1.prompt.txt'), 'Test');

    const mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;

    const testManager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: manager['fs'],
      audit: manager['audit'] as any,
      llm: mockLLM,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    // Mock runLLMVerification to block on a barrier, simulating slow background verification
    vi.spyOn(testManager as any, 'runLLMVerification').mockImplementation(async () => {
      await new Promise<void>(r => { verificationRelease = r; });
      return { passed: true, feedback: 'mocked' };
    });

    // Trigger background verification
    await testManager.completeSubtask({ contractId, subtaskId, evidence: 'done' });

    // Immediately cancel while background is still running
    await testManager.cancel(contractId, 'user cancelled');

    verificationRelease!();

    await vi.waitUntil(async () => {
      const progress = await testManager.getProgress(contractId);
      return progress.status === 'cancelled';
    }, { timeout: 5000 });
  });

  it('cancelled guard returns null + audit VERIFICATION_RESET_FAILED (P0.18)', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancelled Guard Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.cancel(contractId, 'test cancel');

    const beforeAudit = auditCalls.length;

    // Try to complete subtask on cancelled contract
    const result = await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('cancelled');
    expect(result.allCompleted).toBe(false);

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('cancelled');
    expect(progress.subtasks['t1'].status).toBe('todo');

    // phase 1221: predicate 精确 match context=completeSubtaskSync 防 multi-site emit 拿错位
    // (verification.ts 6 site emit VERIFICATION_RESET_FAILED 不同 context 值、phase 1196 β 仅 type match 残留 race)
    const isCompleteSubtaskSyncGuard = (c: { type: string; args: string[] }) =>
      c.type === CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED &&
      c.args.some(a => a.includes('context=completeSubtaskSync'));

    await vi.waitUntil(
      () => auditCalls.slice(beforeAudit).some(isCompleteSubtaskSyncGuard),
      { timeout: 2000, interval: 20 },
    );
    const guardAudits = auditCalls.slice(beforeAudit).filter(isCompleteSubtaskSyncGuard);
    expect(guardAudits.length).toBeGreaterThanOrEqual(1);
    expect(guardAudits[0].args.some(a => a.includes('context=completeSubtaskSync'))).toBe(true);
  });
});

// ───── source: lifecycle-orphan-lock.test.ts ─────
/**
 * ContractSystem lifecycle orphan lock fix (phase 871 / r113 G fork / new.P1.5)
 * Reverse test: fs.move throw → source lock released + throw propagated
 */
describe('phase 871 r113 G fork: contract lock orphan-on-fs-move-throw cluster fix (new.P1.5)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let auditCalls: Array<{ type: string; args: string[] }>;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditCalls = [];
    const captureAudit = {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
      },
    };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // 反向 1: pauseContract fs.move throw → source lock released + throw propagated + LOCK_UNLINK_FAILED audit
  it('pauseContract: fs.move throws → source lock released + throw propagated + LOCK_UNLINK_FAILED audit', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Orphan Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const sourceLockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');

    // Mock fs.move to throw EXDEV (cross-device) only for contract directory moves,
    // not for lock release moves (progress.lock -> progress.lock.released-*).
    const originalMove = nodeFs.move.bind(nodeFs);
    const moveSpy = vi.spyOn(nodeFs, 'move').mockImplementation(async (fromPath: string, toPath: string) => {
      if (path.basename(fromPath) === 'progress.lock' || String(toPath).includes('.released-')) {
        return originalMove(fromPath, toPath);
      }
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });

    await expect(manager.pause(contractId, 'orphan-test')).rejects.toThrow('EXDEV');

    // source lock must be released (deleted)
    await expect(fs.access(sourceLockPath)).rejects.toThrow();

    moveSpy.mockRestore();
  });

  // 反向 2: cancelContract fs.move throw → source lock released + throw propagated
  it('cancelContract: fs.move throws → source lock released + throw propagated', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Orphan Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const sourceLockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');

    // Mock fs.move to throw ENOSPC only for contract directory moves,
    // not for lock release moves.
    const originalMove = nodeFs.move.bind(nodeFs);
    const moveSpy = vi.spyOn(nodeFs, 'move').mockImplementation(async (fromPath: string, toPath: string) => {
      if (path.basename(fromPath) === 'progress.lock' || String(toPath).includes('.released-')) {
        return originalMove(fromPath, toPath);
      }
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });

    await expect(manager.cancel(contractId, 'orphan-test')).rejects.toThrow('ENOSPC');

    // source lock must be released
    await expect(fs.access(sourceLockPath)).rejects.toThrow();

    moveSpy.mockRestore();
  });

  // 反向 3: moveContractToArchive fs.move throw → source lock released + throw propagated
  it('moveContractToArchive: fs.move throws → source lock released + throw propagated', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Archive Orphan Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // phase 188: archive precondition requires terminal status
    // phase 282 Step A: status derive from subtasks → 需先完成所有 subtasks 才能 archive
    await (manager as any).withProgressLock(contractId, async () => {
      const progress = await manager.getProgress(contractId);
      progress.subtasks.t1.status = 'completed';
      progress.subtasks.t1.completed_at = new Date().toISOString();
      await (manager as any).saveProgress(contractId, progress);
    });

    const sourceLockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');

    // Mock fs.move to throw EBUSY only for contract directory moves,
    // not for lock release moves.
    const originalMove = nodeFs.move.bind(nodeFs);
    const moveSpy = vi.spyOn(nodeFs, 'move').mockImplementation(async (fromPath: string, toPath: string) => {
      if (path.basename(fromPath) === 'progress.lock' || String(toPath).includes('.released-')) {
        return originalMove(fromPath, toPath);
      }
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });

    await expect(manager.moveToArchive(contractId)).rejects.toThrow('EBUSY');

    // source lock must be released
    await expect(fs.access(sourceLockPath)).rejects.toThrow();

    moveSpy.mockRestore();
  });

  // 反向 4 (optional): happy path verify 0 regression — pause success → target lock released
  it('happy path: pauseContract fs.move success → target lock released + 0 regression', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Happy Path Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const targetLockPath = path.join(clawDir, 'contract', 'paused', contractId, 'progress.lock');

    await manager.pause(contractId, 'happy-path');

    // After successful pause, contract should be in paused/
    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('paused');

    // target lock should NOT exist (releaseLock at target deletes it)
    await expect(fs.access(targetLockPath)).rejects.toThrow();
  });
});

// ───── source: mark-crashed.test.ts ─────
/**
 * Phase 63 Step G: markCrashed unit tests
 */
describe('phase 63: markCrashed', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let notifyCalls: Array<{ type: string; data: Record<string, unknown> }>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    notifyCalls = [];
    const captureAudit = {
      write: () => {},
    };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
    manager.setOnNotify((type, data) => {
      notifyCalls.push({ type, data });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('saveProgress(status="crashed") + move to archive + safeNotify', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Crash Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    // create 会触发 contract_created notify、清掉只验 markCrashed 的
    notifyCalls.length = 0;

    await manager.markCrashed(contractId, 'system: maxstepsexceedederror');

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('crashed');
    expect(progress.checkpoint).toBe('crashed: system: maxstepsexceedederror');

    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].type).toBe('contract_crashed');
    expect(notifyCalls[0].data).toMatchObject({
      contractId,
      cause: 'system: maxstepsexceedederror',
    });
  });

  it('throws ToolError if contract already in archive', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Crash Already Archived',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.cancel(contractId, 'pre-cancel');
    await expect(manager.markCrashed(contractId, 'cause')).rejects.toThrow(ToolError);
  });

  it('abortContractVerifiers failure does not break main flow', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Crash Abort Throw',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const abortSpy = vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation(() => {
      throw new Error('verifier abort boom');
    });

    await expect(manager.markCrashed(contractId, 'cause')).resolves.toBeUndefined();

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('crashed');

    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();

    abortSpy.mockRestore();
  });

  it('emits CONTRACT_CRASHED audit', async () => {
    const auditWrites: string[][] = [];
    const audit = {
      write: (...args: string[]) => auditWrites.push(args),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    const localManager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: audit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await localManager.create(makeContractYaml({
      title: 'Crash Audit Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await localManager.markCrashed(contractId, 'cause');

    expect(auditWrites.some(a => a[0] === 'contract_crashed' && a.some(s => s.includes('contractId=' + contractId)))).toBe(true);
    expect(auditWrites.some(a => a[0] === 'contract_crashed' && a.some(s => s.includes('cause=cause')))).toBe(true);
  });
});
