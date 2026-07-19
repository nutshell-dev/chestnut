/**
 * Merged from the following source test files (mechanical merge, no assertion/logic changes):
 * - verification-lifecycle.test.ts
 * - verification-pipeline-mutex.test.ts
 * - verification-escalated-state-valid.test.ts
 * - verification-outcome-observability.test.ts
 * - verification-archive-partial-recovery.test.ts
 * - verification-notify.test.ts
 * - verification-sub-file-split.test.ts
 *
 * Phase 1132 Step D adjustments: directory rename is the lifecycle commit point;
 * progress.json no longer persists lifecycle status; guards are based on active path
 * + subtask facts instead of progress.status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit, waitForAuditEvent, makeMockAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { archiveAndEmit } from '../../../src/core/contract/verification-lifecycle.js';  // phase 263: hoist
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { handleVerificationErrorRetry } from '../../../src/core/contract/verification-notify.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import * as VerificationMain from '../../../src/core/contract/verification.js';

/**
 * @module tests/core/contract/verification-lifecycle
 * Phase 951: archiveAndEmit commit-point behavior
 */
describe('archiveAndEmit (phase 951)', () => {
  function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
    return {
      clawDir: '/tmp/claw',
      clawId: 'claw-test',
      audit: {
        __brand: 'AuditLog',
        write: vi.fn(),
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      } as unknown as VerificationContext['audit'],
      notifyClaw: vi.fn(),
      onNotify: vi.fn(),
      moveContractToArchive: vi.fn(),
      emitContractCompleted: vi.fn(),
      getProgress: vi.fn().mockResolvedValue(null),
      saveProgress: vi.fn(),
      withProgressLock: vi.fn(),
      verificationMutex: {} as VerificationContext['verificationMutex'],
      contractDir: vi.fn(),
      loadContractYaml: vi.fn(),
      checkAllSubtasksCompleted: vi.fn(),
      toolRegistry: {} as VerificationContext['toolRegistry'],
      ...overrides,
    } as unknown as VerificationContext;
  }

  function makeYaml() {
    return {
      title: 'Test Contract',
      goal: 'test goal',
      description: 'desc',
      priority: 'normal',
      creator: 'test',
      auth_level: 'auto',
      subtasks: [{ id: 't1', description: 'd1' }],
    } as VerificationContext['loadContractYaml'] extends (...args: any[]) => Promise<infer R> ? NonNullable<R> : never;
  }

  let ctx: VerificationContext;
  let contractYaml: ReturnType<typeof makeYaml>;

  beforeEach(() => {
    ctx = makeCtx();
    contractYaml = makeYaml();
  });

  it('does not archive when emitContractCompleted fails', async () => {
    const contractId = makeContractId('c-1');
    vi.mocked(ctx.moveContractToArchive).mockResolvedValue(undefined);
    vi.mocked(ctx.emitContractCompleted).mockRejectedValue(new Error('emit failed'));

    const result = await archiveAndEmit(ctx, contractId, contractYaml, 'test-context');

    // emit failed before move; contract stays active
    expect(result).toEqual({ archived: false });
    expect(ctx.moveContractToArchive).not.toHaveBeenCalled();
    expect(ctx.withProgressLock).not.toHaveBeenCalled();
    expect(ctx.saveProgress).not.toHaveBeenCalled();

    // emit side effect was attempted
    expect(ctx.emitContractCompleted).toHaveBeenCalledWith(contractId);

    // move-archive-failed audit emitted
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    const moveFailed = auditWrites.find(c => c[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
    expect(moveFailed).toBeDefined();
    expect(moveFailed?.some(col => String(col).includes('emitContractCompleted failed, cannot archive'))).toBe(true);
  });

  it('emits completed audit and notifies after successful emit + move', async () => {
    const contractId = makeContractId('c-2');
    vi.mocked(ctx.moveContractToArchive).mockResolvedValue(undefined);
    vi.mocked(ctx.emitContractCompleted).mockResolvedValue(undefined);

    const result = await archiveAndEmit(ctx, contractId, contractYaml, 'test-context');

    expect(result).toEqual({ archived: true });
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.COMPLETED)).toBe(true);
    expect(ctx.onNotify).toHaveBeenCalled();
  });

  it('returns archived false when moveContractToArchive fails (no rollback + audit)', async () => {
    const contractId = makeContractId('c-3');
    vi.mocked(ctx.moveContractToArchive).mockRejectedValue(new Error('disk full'));

    await expect(archiveAndEmit(ctx, contractId, contractYaml, 'test-context')).resolves.toEqual({ archived: false });

    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED)).toBe(true);
    expect(ctx.saveProgress).not.toHaveBeenCalled();
  });
});

/**
 * @module tests/core/contract/verification-pipeline-mutex
 * Phase 1371 sub-3: completeSubtaskSync vs runVerificationPipeline mutex reverse test
 */
describe('verification pipeline mutex (phase 1371 sub-3)', () => {
  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-verification-mutex-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeManager(audit: any) {
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),});
  }

  it('concurrent runVerificationPipeline attempts → second rejected with race audit', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
    }));

    // Mock runScriptVerification to delay so pipeline stays active
    vi.spyOn(manager as any, 'runScriptVerification').mockImplementation(() => new Promise(() => {}));

    // phase 337 M1 (review-2026-06-13): mutex 现 hold 到 background work 结束 finally。
    // 第一次 await 返后、background work 仍跑（mocked 死锁 promise）、mutex 仍 hold。
    // 第二次 completeSubtask 在 mutex.acquire 处即被拒、抛 "already active — concurrent attempt rejected"
    // 而非进 in-progress 状态守。两条都是合法 reject 路径、仅 wording 不同；
    // 修后期望第一种 wording。
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });

    await expect(
      manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e2' })
    ).rejects.toThrow(/already active — concurrent attempt rejected/);
  });


});

/**
 * @module tests/core/contract/verification-escalated-state-valid
 * Phase 1399: force-accept state transition valid (phase 1399)
 * Verifies that max verification attempts triggers force-accept with valid transition + recovery path.
 */
describe('force-accept state transition valid (phase 1399)', () => {
  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-escalated-valid-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeManager(audit: any) {
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),});
  }

  it('max attempts reached → subtask.status completed + force_accepted + audit emit + archived', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
      verification_attempts: 2,
    }));

    // Mock script verification to always fail
    vi.spyOn(manager as any, 'runScriptVerification').mockResolvedValue({ passed: false, feedback: 'bad' });

    // First failure (wait for background done before next call to avoid mutex race)
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    // Second failure → force-accept (retry_count reaches verification_attempts=2)
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e2' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.COMPLETED);

    // Verify force-accepted audit
    const forceAcceptedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED);
    expect(forceAcceptedEvents.length).toBeGreaterThanOrEqual(1);
    const lastForceAccepted = forceAcceptedEvents[forceAcceptedEvents.length - 1];
    expect(lastForceAccepted.some((c: any) => String(c).includes('contractId=' + contractId))).toBe(true);
    expect(lastForceAccepted.some((c: any) => String(c).includes('subtaskId=t1'))).toBe(true);

    // Verify archived progress shows completed + force_accepted
    const archiveProgressPath = path.join(clawDir, 'contract', 'archive', 'completed', contractId, 'progress.json');
    const archiveRaw = await fs.readFile(archiveProgressPath, 'utf-8');
    const archiveProgress = JSON.parse(archiveRaw);
    expect(archiveProgress.status).toBeUndefined();
    expect(archiveProgress.subtasks['t1'].status).toBe('completed');
    expect(archiveProgress.subtasks['t1'].force_accepted).toBe(true);
  });
});

/**
 * @module tests/core/contract/verification-outcome-observability
 * Phase 1371 sub-4: outcome==null observability reverse test
 */
describe('verification outcome observability (phase 1371 sub-4)', () => {
  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-outcome-observability-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeManager(audit: any) {
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),});
  }

  it('cancelled contract → lifecycle guard rejects without starting background verification', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
    }));

    // Cancel the contract
    await manager.cancel(contractId, 'test cancel');

    // Mock runScriptVerification so it would succeed if not cancelled
    const runScriptSpy = vi.spyOn(manager as any, 'runScriptVerification').mockResolvedValue({ passed: true, feedback: 'ok' });

    // Start pipeline — lifecycle guard should reject before background starts
    const result = await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });

    expect(result.passed).toBe(false);
    expect(result.async).toBeUndefined();
    expect(result.feedback).toContain('not active');
    expect(runScriptSpy).not.toHaveBeenCalled();

    // No background done audit should be emitted
    const doneEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
    expect(doneEvents.length).toBe(0);
  });

  it('missing subtask → background done audit contains outcomeKind=missing_subtask + missing_subtask_id', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
    }));

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');

    // Mock runScriptVerification to delay, then delete subtask mid-flight
    vi.spyOn(manager as any, 'runScriptVerification').mockImplementation(async () => {
      // Delete subtask while background verification is running
      const raw = await fs.readFile(progressPath, 'utf-8');
      const progress = JSON.parse(raw);
      delete progress.subtasks['t1'];
      await fs.writeFile(progressPath, JSON.stringify(progress));
      return { passed: true, feedback: 'ok' };
    });

    // Start pipeline
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });

    // Wait for background done audit
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const doneEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    const lastDone = doneEvents[doneEvents.length - 1];
    expect(lastDone.some((c: any) => String(c).includes('result=missing_subtask'))).toBe(true);
    expect(lastDone.some((c: any) => String(c).includes('missing_subtask_id=t1'))).toBe(true);
  });
});

/**
 * @module tests/core/contract/verification-archive-partial-recovery
 * Phase 1371 sub-2: archiveAndEmit partial recovery reverse test
 *
 * Phase 1132 Step D: archive_pending_recovery and status rollback are removed.
 */
describe('archiveAndEmit failure recovery (phase 1132 Step D)', () => {
  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-archive-failure-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeManager(audit: any) {
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),});
  }

  it('archive fails → no status rollback, contract stays active, MOVE_ARCHIVE_FAILED audit emitted', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({ subtasks: [{ id: 't1', description: 'd1' }] }));

    // Mark subtask completed so archiveAndEmit will try to archive
    await (manager as any).withProgressLock(contractId, async () => {
      const progress = await manager.getProgress(contractId);
      progress.subtasks['t1'].status = 'completed';
      progress.subtasks['t1'].completed_at = new Date().toISOString();
      await (manager as any).saveProgress(contractId, progress);
    });

    // Spy moveToArchive to throw (simulating archive failure)
    vi.spyOn(manager as any, 'moveToArchive').mockRejectedValue(new Error('disk full'));

    await archiveAndEmit(
      (manager as any)._verificationCtx(),
      contractId,
      'test-title',
      'test-context',
    );

    // Verify audit emit for move failure
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
    const moveFailedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
    expect(moveFailedEvents.length).toBeGreaterThanOrEqual(1);

    // Contract stays active
    const activeExists = await fs.access(path.join(clawDir, 'contract', 'active', contractId)).then(() => true).catch(() => false);
    expect(activeExists).toBe(true);

    // progress.json has no persisted status
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    const raw = await fs.readFile(progressPath, 'utf-8');
    const progress = JSON.parse(raw);
    expect(progress.status).toBeUndefined();
  });
});

/**
 * verification-notify retry-state-machine tests (Phase 968)
 */
describe('handleVerificationErrorRetry (Phase 968)', () => {
  function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
    return {
      clawDir: '/tmp/claw',
      clawId: 'claw-test',
      audit: makeMockAudit() as unknown as VerificationContext['audit'],
      notifyClaw: vi.fn(),
      fs: {} as unknown as FileSystem,
      contractDir: vi.fn().mockResolvedValue('contract/active'),
      withProgressLock: vi.fn((_id, fn) => fn()),
      getProgress: vi.fn().mockResolvedValue(null),
      saveProgress: vi.fn().mockResolvedValue(undefined),
      loadContractYaml: vi.fn().mockResolvedValue({
        subtasks: [{ id: 'st1', description: 'desc' }],
        verification_attempts: 3,
      }),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(false),
      toolRegistry: {} as VerificationContext['toolRegistry'],
      isActiveContract: vi.fn().mockResolvedValue(true),
      getContractRoot: vi.fn().mockResolvedValue('contract/active'),
      transitionVerificationAttempt: vi.fn().mockResolvedValue({ kind: 'skipped', reason: 'not configured' }),
      ...overrides,
    } as VerificationContext;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mutate subtask when contract is not active', async () => {
    const contractId = 'c1';
    const subtaskId = 'st1';
    const progress = {
      subtasks: {
        [subtaskId]: { status: 'in_progress', retry_count: 0 },
      },
    };
    const audit = makeMockAudit();
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      audit: audit as unknown as VerificationContext['audit'],
      saveProgress,
      getProgress: vi.fn().mockResolvedValue(progress),
      isActiveContract: vi.fn().mockResolvedValue(false),
    });

    await handleVerificationErrorRetry(ctx, contractId, subtaskId, 'programming_bug', 'crash');

    expect(saveProgress).not.toHaveBeenCalled();
    expect(progress.subtasks[subtaskId].status).toBe('in_progress');
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED,
      expect.stringContaining(`contractId=${contractId}`),
      expect.stringContaining(`subtaskId=${subtaskId}`),
      expect.stringContaining('handleVerificationErrorRetry'),
      expect.stringContaining('no longer active'),
    );
  });

  it('still resets in_progress subtask to todo when contract is active', async () => {
    const contractId = 'c1';
    const subtaskId = 'st1';
    const progress = {
      subtasks: {
        [subtaskId]: { status: 'in_progress', retry_count: 0 },
      },
    };
    const updatedProgress = {
      subtasks: {
        [subtaskId]: { status: 'todo', retry_count: 1, last_failed_feedback: { feedback: 'crash', cause: 'programming_bug' } },
      },
    };
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'updated',
      progress: updatedProgress,
    });
    const ctx = makeCtx({
      getProgress: vi.fn().mockResolvedValue(progress),
      transitionVerificationAttempt,
    });

    await handleVerificationErrorRetry(ctx, contractId, subtaskId, 'programming_bug', 'crash');

    expect(transitionVerificationAttempt).toHaveBeenCalledWith(
      contractId,
      subtaskId,
      expect.objectContaining({ kind: 'reject', cause: 'programming_bug', forceAccept: false }),
    );
    expect(updatedProgress.subtasks[subtaskId].status).toBe('todo');
    expect(updatedProgress.subtasks[subtaskId].retry_count).toBe(1);
  });
});

describe('phase 1237 contract/verification sub-file cluster DAG', () => {
  const SUB_FILES = [
    'verification-format.ts',
    'verification-notify.ts',
    'verification-execution.ts',
    'verification-lifecycle.ts',
  ];

  // 反向 1: 公开 API signature 不动
  it('public exports: 9 functions unchanged', () => {
    expect(typeof VerificationMain.runVerificationPipeline).toBe('function');
    expect(typeof VerificationMain.runVerificationInBackground).toBe('function');
    expect(typeof VerificationMain.archiveAndEmit).toBe('function');
    expect(typeof VerificationMain.completeSubtaskSync).toBe('function');
    expect(typeof VerificationMain.writeVerificationInbox).toBe('function');
    expect(typeof VerificationMain.writeVerificationError).toBe('function');
    expect(typeof VerificationMain.formatRejectionFeedback).toBe('function');
    expect(typeof VerificationMain.runScriptVerification).toBe('function');
    expect(typeof VerificationMain.runLLMVerification).toBe('function');
  });

  // 反向 2: cluster DAG / 无 cycle (per phase 1228 DAG 断言模板)
  it('4 sub-file cluster forms a DAG (no cycle / M#5 严格判断)', async () => {
    const importMap = new Map<string, Set<string>>();
    for (const file of SUB_FILES) {
      const content = await fs.readFile(`src/core/contract/${file}`, 'utf-8');
      const imports = new Set<string>();
      for (const other of SUB_FILES) {
        if (other === file) continue;
        const otherBase = other.replace('.ts', '');
        if (new RegExp(`from ['"]\\./${otherBase}`).test(content)) {
          imports.add(other);
        }
      }
      importMap.set(file, imports);
    }

    function hasCycle(): boolean {
      const WHITE = 0, GRAY = 1, BLACK = 2;
      const color = new Map<string, number>();
      for (const f of SUB_FILES) color.set(f, WHITE);

      function dfs(node: string): boolean {
        color.set(node, GRAY);
        const deps = importMap.get(node) ?? new Set();
        for (const dep of deps) {
          if (color.get(dep) === GRAY) return true;
          if (color.get(dep) === WHITE && dfs(dep)) return true;
        }
        color.set(node, BLACK);
        return false;
      }

      for (const f of SUB_FILES) {
        if (color.get(f) === WHITE && dfs(f)) return true;
      }
      return false;
    }

    expect(hasCycle()).toBe(false);
  });

  // 反向 3: thin pipeline imports 4 sub-file
  it('verification.ts (thin pipeline) imports all 4 sub-file', async () => {
    const main = await fs.readFile('src/core/contract/verification.ts', 'utf-8');
    const expected = ['verification-format', 'verification-notify', 'verification-execution', 'verification-lifecycle'];
    for (const sub of expected) {
      expect(main).toMatch(new RegExp(`from ['"]\\./${sub}`));
    }
  });
});
