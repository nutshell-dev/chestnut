/**
 * Merged from the following source test files (mechanical merge, no assertion/logic changes):
 * - verification-force-accept-inbox.test.ts
 * - verification-notify-motion-inbox.test.ts
 * - no-verification-path.test.ts
 * - phase961-verification-invariants.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { writeForceAcceptInbox, writeVerificationInbox, writeVerificationError } from '../../../src/core/contract/verification-notify.js';
import * as verificationNotifyMod from '../../../src/core/contract/verification-notify.js';  // phase 263: hoist
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { routeNotifyClaw } from '../../../src/core/claw-topology/index.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit, waitForAuditEvent, makeMockAudit } from '../../helpers/audit.js';
import { runVerificationInBackground } from '../../../src/core/contract/verification.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

/**
 * @module tests/core/contract/verification-force-accept-inbox
 * Phase 1405 Fix 1: writeForceAcceptInbox helper 写 claw inbox 反馈
 *
 * Phase 1399 force-accept path 漏写 claw inbox → submit_subtask async 模式 claw 永远等不到 verdict.
 * 本测试核 writeForceAcceptInbox 正确写 verification_result inbox + extraFields.force_accepted='true'.
 */
describe('phase 1405 Fix 1: writeForceAcceptInbox', () => {
  function makeMinimalCtx(clawDir: string, clawId: string, nodeFs: NodeFileSystem, chestnutRoot: string): VerificationContext {
    const audit = { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any;
    return {
      clawDir: clawDir as any,
      clawId: clawId as any,
      audit,
      fs: nodeFs as any,
      notifyClaw: (targetClawId, message) => routeNotifyClaw(nodeFs, chestnutRoot, 'motion', targetClawId, message, audit),
      contractDir: vi.fn(async (id: string) => path.join(clawDir, 'contract', 'active', id)),
      loadContractYaml: vi.fn(async () => ({
        title: 'Test', goal: 'Test',
        subtasks: [{ id: 'st1', description: 'ST1' }],
      })),
      getProgress: vi.fn(async () => ({ contract_id: 'c1', status: 'running', subtasks: {} })),
      saveProgress: vi.fn(async () => {}),
      checkAllSubtasksCompleted: vi.fn(async () => false),
      moveContractToArchive: vi.fn(async () => {}),
      emitContractCompleted: vi.fn(async () => {}),
      onNotify: () => {},
      runScriptVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
      runLLMVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
      withProgressLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
      toolRegistry: createToolRegistry(),
      runVerifierWithCancel: vi.fn(async () => ({ passed: true, feedback: '' })),
    };
  }

  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('phase1405-fa-inbox-');
    originalEnv = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalEnv;
    await cleanupTempDir(tempDir);
  });

  it('writes an inbox file with verdict=passed + force_accepted=true extraField', () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'test-claw');
    const inboxPending = path.join(clawDir, 'inbox', 'pending');
    fs.mkdirSync(inboxPending, { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(clawDir, 'test-claw', nodeFs, chestnutRoot);

    writeForceAcceptInbox(ctx, 'c1' as any, 'st1' as any, false, 3, 'bad output');

    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(inboxPending, files[0]), 'utf8');
    expect(content).toContain('verdict: "passed"');
    expect(content).toMatch(/force_accepted:\s*true/);
    expect(content).toMatch(/retry_count:\s*3/);
    expect(content).toContain('force-accepted after 3 attempts');
    expect(content).toContain('last_failure: bad output');
  });

  it('emits "All subtasks complete!" when allCompleted=true', () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'test-claw');
    const inboxPending = path.join(clawDir, 'inbox', 'pending');
    fs.mkdirSync(inboxPending, { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(clawDir, 'test-claw', nodeFs, chestnutRoot);

    writeForceAcceptInbox(ctx, 'c1' as any, 'st1' as any, true, 2, undefined);

    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(inboxPending, files[0]), 'utf8');
    expect(content).toContain('All subtasks complete!');
    expect(content).not.toContain('last_failure');
  });

  it('reverse: helper exported from verification-notify barrel', async () => {
    expect(typeof verificationNotifyMod.writeForceAcceptInbox).toBe('function');
  });
});

describe('phase 1388 Bug B: verification-notify Motion 端写正确 motion/inbox/pending', () => {
  function makeMinimalCtx(clawDir: string, clawId: string, nodeFs: NodeFileSystem, chestnutRoot: string): VerificationContext {
    const audit = { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any;
    return {
      clawDir: clawDir as any,
      clawId: clawId as any,
      audit,
      fs: nodeFs as any,
      notifyClaw: (targetClawId, message) => routeNotifyClaw(nodeFs, chestnutRoot, 'motion', targetClawId, message, audit),
      contractDir: vi.fn(async (id: string) => path.join(clawDir, 'contract', 'active', id)),
      loadContractYaml: vi.fn(async () => ({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 'st1', description: 'ST1' }],
      })),
      getProgress: vi.fn(async () => ({
        contract_id: 'c1',
        status: 'running',
        subtasks: {},
      })),
      saveProgress: vi.fn(async () => {}),
      checkAllSubtasksCompleted: vi.fn(async () => false),
      moveContractToArchive: vi.fn(async () => {}),
      emitContractCompleted: vi.fn(async () => {}),
      onNotify: () => {},
      runScriptVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
      runLLMVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
      withProgressLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
      toolRegistry: createToolRegistry(),
      runVerifierWithCancel: vi.fn(async () => ({ passed: true, feedback: '' })),
    };
  }

  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('phase1388-bug-b-');
    originalEnv = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalEnv;
    }
    await cleanupTempDir(tempDir);
  });

  it('Motion 路径 writeVerificationInbox 写到 .chestnut/motion/inbox/pending', () => {
    const motionDir = path.join(tempDir, '.chestnut', 'motion');
    fs.mkdirSync(path.join(motionDir, 'inbox', 'pending'), { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(motionDir, 'motion', nodeFs, chestnutRoot);

    writeVerificationInbox(ctx, 'c1', 'st1', 'passed', false);

    // 正确路径有文件
    const inboxPending = path.join(tempDir, '.chestnut', 'motion', 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);

    // 错位路径不存在
    const wrongPath = path.join(tempDir, 'motion', 'inbox', 'pending');
    expect(fs.existsSync(wrongPath)).toBe(false);
  });

  it('Motion 路径 writeVerificationError 写到 .chestnut/motion/inbox/pending', async () => {
    const motionDir = path.join(tempDir, '.chestnut', 'motion');
    fs.mkdirSync(path.join(motionDir, 'inbox', 'pending'), { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(motionDir, 'motion', nodeFs, chestnutRoot);
    (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      contract_id: 'c1',
      status: 'running',
      subtasks: {
        st1: { status: 'in_progress', retry_count: 0 },
      },
    });

    await writeVerificationError(ctx, 'c1', 'st1', new Error('test'));

    const inboxPending = path.join(tempDir, '.chestnut', 'motion', 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);

    const wrongPath = path.join(tempDir, 'motion', 'inbox', 'pending');
    expect(fs.existsSync(wrongPath)).toBe(false);
  });

  it('普通 claw 路径 writeVerificationInbox 写到 .chestnut/claws/<id>/inbox/pending (regression-guard)', () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'test-claw');
    fs.mkdirSync(path.join(clawDir, 'inbox', 'pending'), { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(clawDir, 'test-claw', nodeFs, chestnutRoot);

    writeVerificationInbox(ctx, 'c1', 'st1', 'passed', false);

    const inboxPending = path.join(tempDir, '.chestnut', 'claws', 'test-claw', 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);
  });
});

/**
 * No-verification path tests
 *
 * Verifies that when a contract has NO `verification` field, submitting a subtask
 * immediately marks it as completed (skipping the verification background pipeline).
 */
describe('no verification path', () => {
  /**
   * Promise barrier release for mock background verification.
   * Keeps the subtask in_progress until the test explicitly releases it.
   */
  let verificationRelease: (() => void) | undefined;

  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-no-verification-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fsp.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('submit with no verification → immediately completed', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(
      makeContractYaml({
        verification: undefined,
      }),
    );

    const result = await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    // Assert subtask status is completed immediately
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['task-1'].status).toBe('completed');

    // Assert result indicates completion
    expect(result.passed).toBe(true);
    expect(result.allCompleted).toBe(true);

    // Assert subtask_completed audit event was emitted
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED);
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED)).toBe(true);

    // Assert verification_started was NOT emitted (indirectly proves background
    // verification pipeline was skipped)
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED)).toBe(false);
  });

  it('submit with verification → goes to background path', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(
      makeContractYaml({
        verification: [
          {
            subtask_id: 'task-1',
            type: 'llm',
            prompt_file: 'verification/task-1.prompt.txt',
          },
        ],
      }),
    );

    // Create prompt file directory and file so the background verifier can find it
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fsp.mkdir(path.join(contractDir, 'verification'), { recursive: true });
    await fsp.writeFile(
      path.join(contractDir, 'verification', 'task-1.prompt.txt'),
      'Test prompt',
      'utf-8',
    );

    // Mock runLLMVerification to block on a barrier, keeping the subtask in_progress for the
    // duration of this test so assertions are deterministic.
    vi.spyOn(manager as any, 'runLLMVerification').mockImplementation(async () => {
      await new Promise<void>(r => { verificationRelease = r; });
      return { passed: true, feedback: 'mocked' };
    });

    const result = await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    // Assert subtask status is in_progress — NOT completed immediately
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['task-1'].status).toBe('in_progress');

    // Assert result indicates async background verification
    expect(result.async).toBe(true);
    expect(result.passed).toBe(false);

    // Assert verification_started audit event was emitted
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED);
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED)).toBe(true);

    // Release the barrier so the mock verification can settle and cleanup.
    verificationRelease!();
  });

  it('submit with no verification notifies caller', async () => {
    const { audit } = makeAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(
      makeContractYaml({
        verification: undefined,
      }),
    );

    const notifyCalls: Array<{ type: string; data: Record<string, unknown> }> = [];
    manager.setOnNotify((type, data) => {
      notifyCalls.push({ type, data });
    });

    await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    // Assert onNotify was called with subtask_completed
    const subtaskCompletedCalls = notifyCalls.filter((c) => c.type === 'subtask_completed');
    expect(subtaskCompletedCalls.length).toBeGreaterThanOrEqual(1);
    expect(subtaskCompletedCalls[0].data).toMatchObject({
      contractId,
      subtaskId: 'task-1',
    });
  });
});

/**
 * Phase 961 — verification attempt ID + archive under lock + audit isolation
 */
describe('Phase 961 verification invariants', () => {
  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-phase961-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fsp.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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
      notifyClaw: vi.fn(),
    });
  }

  it('classifies mismatched verification_attempt_id as late with zero side effects', async () => {
    const mockAudit = makeMockAudit();
    const moveToArchiveSpy = vi.fn().mockResolvedValue(undefined);
    const emitContractCompletedSpy = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      clawDir: '/tmp/claw',
      clawId: 'claw-test',
      audit: mockAudit as unknown as VerificationContext['audit'],
      notifyClaw: vi.fn(),
      contractDir: vi.fn().mockResolvedValue('contract/active'),
      loadContractYaml: vi.fn().mockResolvedValue({}),
      getProgress: vi.fn().mockResolvedValue({
        status: 'running',
        subtasks: {
          t1: { status: 'in_progress', verification_attempt_id: 'attempt-B' },
        },
      }),
      saveProgress: vi.fn().mockResolvedValue(undefined),
      withProgressLock: vi.fn().mockImplementation((_, fn) => fn()),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(true),
      moveContractToArchive: moveToArchiveSpy,
      emitContractCompleted: emitContractCompletedSpy,
      runLLMVerification: vi.fn().mockResolvedValue({ passed: true, feedback: 'ok' }),
      runScriptVerification: vi.fn(),
      toolRegistry: createToolRegistry(),
      verificationMutex: { acquire: vi.fn(() => true), release: vi.fn() } as unknown as VerificationContext['verificationMutex'],
      runVerifierWithCancel: vi.fn(),
      onNotify: vi.fn(),
      isActiveContract: vi.fn().mockResolvedValue(true),
      getContractRoot: vi.fn().mockResolvedValue('contract/active'),
      transitionVerificationAttempt: vi.fn().mockResolvedValue({ kind: 'late', expectedAttemptId: 'attempt-B', actualAttemptId: 'attempt-A' }),
    } as unknown as VerificationContext;

    const contractYaml = makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' }],
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 't1', evidence: 'e1', attemptId: 'attempt-A' },
      contractYaml,
      { subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' },
    );

    // Stale attemptId A does not match current attemptId B; outcome is late and no archive happens.
    expect(moveToArchiveSpy).not.toHaveBeenCalled();
    expect(emitContractCompletedSpy).not.toHaveBeenCalled();

    const doneAudit = vi.mocked(mockAudit.write).mock.calls.find(
      c => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    );
    expect(doneAudit).toBeDefined();
    expect(doneAudit?.some(col => String(col).includes('result=late'))).toBe(true);

    expect(vi.mocked(mockAudit.write).mock.calls.some(
      c => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED,
    )).toBe(false);
    expect(vi.mocked(mockAudit.write).mock.calls.some(
      c => c[0] === CONTRACT_AUDIT_EVENTS.PASSED || c[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED,
    )).toBe(false);

    expect(ctx.notifyClaw).not.toHaveBeenCalled();
  });

  it('does not archive cancelled contract after stale verification result', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' }],
    }));

    let cancelDone = false;
    vi.spyOn(manager as any, 'runLLMVerification').mockImplementation(async () => {
      // Cancel the contract before returning the passing result.
      if (!cancelDone) {
        cancelDone = true;
        await manager.cancel(contractId, 'cancel before archive');
      }
      return { passed: true, feedback: 'ok' };
    });

    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const contractDir = await (manager as any).contractDir(contractId);
    expect(contractDir).toBe('contract/archive/cancelled');

    // Phase 1132 Step D: lifecycle state is expressed by directory location;
    // progress.json no longer persists a lifecycle status field.
    const archiveProgressPath = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId, 'progress.json');
    const archiveRaw = await fsp.readFile(archiveProgressPath, 'utf-8');
    const archiveProgress = JSON.parse(archiveRaw);
    expect(archiveProgress.status).toBeUndefined();
  });

  it('resets subtask even when audit emit throws', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' }],
    }));

    vi.spyOn(manager as any, 'runLLMVerification').mockRejectedValue(new Error(' verifier crashed'));

    // Make the audit emit throw only for the background-failure audit event.
    const originalWrite = audit.write;
    audit.write = vi.fn((type: string, ...cols: (string | number)[]) => {
      if (type === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_FAILED) {
        throw new Error('audit emit failed');
      }
      return originalWrite(type, ...cols);
    });

    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });
    await vi.waitFor(async () => {
      const p = await manager.getProgress(contractId);
      expect(p?.subtasks.t1.status).toBe('todo');
    }, { timeout: 10000 });

    const progress = await manager.getProgress(contractId);
    expect(progress?.subtasks.t1.retry_count).toBe(1);
  });
});
