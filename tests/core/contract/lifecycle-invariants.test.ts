/**
 * ContractSystem lifecycle invariants — merged test file
 *
 * Sources:
 * - lifecycle.test.ts
 * - lifecycle-race.test.ts
 * - lifecycle-orphan-lock.test.ts
 * - mark-crashed.test.ts
 *
 * Phase 1132 Step D: lifecycle 终态由目录 rename 表达；progress.json 不再写 status。
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
import type { ContractNotification } from '../../../src/core/contract/notification.js';
import { ToolError } from '../../../src/foundation/tools/errors.js';
import { completeSubtask } from '../../helpers/contract-subtask.js';
import * as path from 'path';
import { readLifecycleIntentsForContract } from '../../../src/core/contract/lifecycle-intent.js';



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
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('Phase 1198 Step C: cancel archives contract without pre-rename progress mutation', async () => {
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

    const outcome = await manager.cancel(contractId, 'test');
    expect(outcome.kind).toBe('committed');
    expect(outcome.state).toBe('cancelled');

    const archiveDir = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);

    // Phase 1198 Step C: no pre-rename progress mutation; subtask state is preserved.
    const archivedProgressPath = path.join(archiveDir, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBeUndefined();
    expect(archivedProgress.subtasks['task-1'].status).toBe('in_progress');

    // Reason is persisted in the immutable lifecycle intent store.
    const { intents } = await readLifecycleIntentsForContract(
      manager['fs'],
      manager['audit'] as any,
      clawDir,
      contractId,
    );
    expect(intents.some(i => i.requested_state === 'cancelled' && (i as { reason: string }).reason === 'test')).toBe(true);
  });

  it('Phase 1198 Step C: markCorrupted archives contract without pre-rename progress mutation', async () => {
    const contractId = await manager.create({
      title: 'Corrupt Test',
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

    const outcome = await manager.markCorrupted(contractId, {
      reason: 'progress_schema_invalid',
      relativePath: 'corrupted/123_progress.json',
    });
    expect(outcome.kind).toBe('committed');
    expect(outcome.state).toBe('corrupted');

    const archiveDir = path.join(clawDir, 'contract', 'archive', 'corrupted', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);

    // Phase 1198 Step C: no pre-rename progress mutation; subtask state is preserved.
    const archivedProgressPath = path.join(archiveDir, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBeUndefined();
    expect(archivedProgress.subtasks['task-1'].status).toBe('in_progress');

    // Evidence is persisted in the immutable lifecycle intent store.
    const { intents } = await readLifecycleIntentsForContract(
      manager['fs'],
      manager['audit'] as any,
      clawDir,
      contractId,
    );
    expect(intents.some(i =>
      i.requested_state === 'corrupted' &&
      (i as { evidence: { reason: string; relativePath: string } }).evidence.reason === 'progress_schema_invalid'
    )).toBe(true);
  });

  it('Phase 1198 Step E + phase 1862 Step B (CT-D5): cancel emits verifier abort failure as independent event', async () => {
    const contractId = await manager.create({
      title: 'Cancel Abort Throw',
      goal: 'test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }],
      verification: [],
    });

    vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation(() => {
      throw new Error('verifier abort boom');
    });

    const outcome = await manager.cancel(contractId, 'test');
    expect(outcome.kind).toBe('committed');

    const auditWrite = manager['audit'].write as ReturnType<typeof vi.fn>;
    const cancelledCalls = auditWrite.mock.calls.filter(
      (c: unknown[]) => c[0] === CONTRACT_AUDIT_EVENTS.CANCELLED,
    );
    // phase 1862 Step B (CT-D5): cancelled 载荷回归纯取消事实，无 abort 失败字段。
    expect(cancelledCalls.some((c: unknown[]) =>
      c.some(col => String(col).startsWith('abort_verifier_failed=')),
    )).toBe(false);
    // abort 失败事实由独立事件承载。
    const abortFailedCalls = auditWrite.mock.calls.filter(
      (c: unknown[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_VERIFIER_ABORT_FAILED,
    );
    expect(abortFailedCalls).toHaveLength(1);
    expect(abortFailedCalls[0].some((col: unknown) =>
      String(col).startsWith('error=') && String(col).includes('verifier abort boom'),
    )).toBe(true);
  });

  it('phase 1862 Step B (CT-D5): unsafe controller.abort throw emits independent event, not a reason-less cancelled row', async () => {
    const contractId = await manager.create({
      title: 'Cancel Unsafe Abort Throw',
      goal: 'test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }],
      verification: [],
    });

    const failingController = {
      abort: () => { throw new Error('unsafe abort boom'); },
    } as unknown as AbortController;
    (manager as any)._activeContractControllers.set(
      contractId,
      new Set([{ controller: failingController, promise: Promise.resolve() }]),
    );

    const outcome = await manager.cancel(contractId, 'test unsafe abort');
    expect(outcome.kind).toBe('committed');

    const auditWrite = manager['audit'].write as ReturnType<typeof vi.fn>;
    // 无 reason 的 cancelled 行不再作为 abort 失败载体（历史混淆源）。
    const cancelledCalls = auditWrite.mock.calls.filter(
      (c: unknown[]) => c[0] === CONTRACT_AUDIT_EVENTS.CANCELLED,
    );
    expect(cancelledCalls).toHaveLength(1);
    expect(cancelledCalls[0].some((col: unknown) => String(col).startsWith('reason='))).toBe(true);
    expect(cancelledCalls[0].some((col: unknown) => String(col).startsWith('abort_verifier_failed='))).toBe(false);
    // abort 失败事实由独立事件承载。
    const abortFailedCalls = auditWrite.mock.calls.filter(
      (c: unknown[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_VERIFIER_ABORT_FAILED,
    );
    expect(abortFailedCalls).toHaveLength(1);
    expect(abortFailedCalls[0].some((col: unknown) =>
      String(col).startsWith('error=') && String(col).includes('unsafe abort boom'),
    )).toBe(true);
  });

  it('phase 1862 Step B (CT-D5): successful cancel emits no verifier-abort-failed event', async () => {
    const contractId = await manager.create({
      title: 'Cancel Abort Ok',
      goal: 'test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }],
      verification: [],
    });

    const outcome = await manager.cancel(contractId, 'test');
    expect(outcome.kind).toBe('committed');

    const auditWrite = manager['audit'].write as ReturnType<typeof vi.fn>;
    const abortFailedCalls = auditWrite.mock.calls.filter(
      (c: unknown[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_VERIFIER_ABORT_FAILED,
    );
    expect(abortFailedCalls).toHaveLength(0);
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
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
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
        schema_version: 1,
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
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    // Mock runLLMVerification to block on a barrier, simulating slow background verification
    vi.spyOn(testManager as any, 'runLLMVerification').mockImplementation(async () => {
      await new Promise<void>(r => { verificationRelease = r; });
      return { passed: true, feedback: 'mocked' };
    });

    // Trigger background verification
    await completeSubtask(testManager, { contractId, subtaskId, evidence: 'done' });

    // Immediately cancel while background is still running
    await testManager.cancel(contractId, 'user cancelled');

    // Archive is the lifecycle commit point; contract should already be in archive/cancelled
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);

    verificationRelease!();

    // Wait for any background cleanup to settle, then confirm archive stayed and no active dir resurrection
    await vi.waitUntil(async () => {
      const activeStillExists = await fs.stat(path.join(clawDir, 'contract', 'active', contractId)).then(() => true).catch(() => false);
      const archiveStillExists = await fs.stat(archiveDir).then(() => true).catch(() => false);
      return !activeStillExists && archiveStillExists;
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
    const result = await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'done' });

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('not active');
    expect(result.allCompleted).toBe(false);

    // Cancelled contract lives in archive/cancelled
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);

    const archivedProgressPath = path.join(archiveDir, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBeUndefined();
    expect(archivedProgress.subtasks['t1'].status).toBe('todo');

    // Phase 1132 Step D: the lifecycle guard now lives in runVerificationPipeline
    // (active-path check) rather than completeSubtaskSync. Wait for the corresponding
    // VERIFICATION_RESET_FAILED audit emitted from that context.
    const isPipelineGuard = (c: { type: string; args: string[] }) =>
      c.type === CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED &&
      c.args.some(a => a.includes('context=runVerificationPipeline'));

    await vi.waitUntil(
      () => auditCalls.slice(beforeAudit).some(isPipelineGuard),
      { timeout: 2000, interval: 20 },
    );
    const guardAudits = auditCalls.slice(beforeAudit).filter(isPipelineGuard);
    expect(guardAudits.length).toBeGreaterThanOrEqual(1);
    expect(guardAudits[0].args.some(a => a.includes('context=runVerificationPipeline'))).toBe(true);
  });
});



// ───── source: mark-crashed.test.ts ─────
/**
 * Phase 1121 Step C: markCorrupted unit tests
 */
describe('phase 1121 Step C: markCorrupted', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let notifyCalls: ContractNotification[];
  let auditWrites: string[][];

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    notifyCalls = [];
    auditWrites = [];
    const captureAudit = {
      write: (...args: string[]) => {
        auditWrites.push(args);
      },
    };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
    manager.setOnNotify((event) => {
      notifyCalls.push(event);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('Phase 1198 Step C: intent + move to corrupted archive + no notify', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Corrupt Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    // create 会触发 contract_created notify、清掉只验 markCorrupted 的
    notifyCalls.length = 0;

    const outcome = await manager.markCorrupted(contractId, {
      reason: 'progress_schema_invalid',
      relativePath: 'corrupted/123_progress.json',
    });
    expect(outcome.kind).toBe('committed');

    const archiveContractDir = path.join(clawDir, 'contract', 'archive', 'corrupted', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();

    const archivedProgressPath = path.join(archiveContractDir, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBeUndefined();
    // Phase 1198 Step E: terminal commit performs zero progress mutation.
    // The legacy checkpoint:null placeholder from creation is left untouched.
    expect(archivedProgress.checkpoint).toBeNull();

    const { intents } = await readLifecycleIntentsForContract(
      manager['fs'],
      manager['audit'] as any,
      clawDir,
      contractId,
    );
    expect(intents.some(i =>
      i.requested_state === 'corrupted' &&
      (i as { evidence: { reason: string; relativePath: string } }).evidence.reason === 'progress_schema_invalid'
    )).toBe(true);

    // phase 1121 Step D: 新 contract_crashed notify 已删除
    expect(notifyCalls).toHaveLength(0);
  });

  it('Phase 1198 Step C: returns lost_to_state if contract already in archive', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Corrupt Already Archived',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.cancel(contractId, 'pre-cancel');
    const outcome = await manager.markCorrupted(contractId, {
      reason: 'progress_schema_invalid',
      relativePath: 'corrupted/123_progress.json',
    });
    expect(outcome.kind).toBe('lost_to_state');
    expect(outcome.committed).toBe('cancelled');
  });

  it('abortContractVerifiers failure does not break main flow', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Corrupt Abort Throw',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const abortSpy = vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation(() => {
      throw new Error('verifier abort boom');
    });

    const outcome = await manager.markCorrupted(contractId, {
      reason: 'progress_schema_invalid',
      relativePath: 'corrupted/123_progress.json',
    });
    expect(outcome.kind).toBe('committed');

    const archiveContractDir = path.join(clawDir, 'contract', 'archive', 'corrupted', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();

    const archivedProgressPath = path.join(archiveContractDir, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBeUndefined();

    // phase 1862 Step B (CT-D5): corrupted 载荷无 abort 失败字段；失败事实由独立事件承载。
    const corruptedCalls = auditWrites.filter(c => c[0] === CONTRACT_AUDIT_EVENTS.CORRUPTED);
    expect(corruptedCalls.some(c =>
      c.some(col => String(col).startsWith('abort_verifier_failed=')),
    )).toBe(false);
    const abortFailedCalls = auditWrites.filter(c => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_VERIFIER_ABORT_FAILED);
    expect(abortFailedCalls).toHaveLength(1);
    expect(abortFailedCalls[0].some(col =>
      String(col).startsWith('error=') && String(col).includes('verifier abort boom'),
    )).toBe(true);

    abortSpy.mockRestore();
  });

  it('emits CONTRACT_CORRUPTED audit', async () => {
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
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await localManager.create(makeContractYaml({
      title: 'Corrupt Audit Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await localManager.markCorrupted(contractId, {
      reason: 'progress_schema_invalid',
      relativePath: 'corrupted/123_progress.json',
    });

    expect(auditWrites.some(a => a[0] === 'contract_corrupted' && a.some(s => s.includes('contractId=' + contractId)))).toBe(true);
    expect(auditWrites.some(a => a[0] === 'contract_corrupted' && a.some(s => s.includes('reason=progress_schema_invalid')))).toBe(true);
    expect(auditWrites.some(a => a[0] === 'contract_lifecycle_intent_persisted' && a.some(s => s.includes('contractId=' + contractId)))).toBe(true);
  });
});