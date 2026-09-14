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
import { completeSubtask } from '../../helpers/contract-subtask.js';

/**
 * @module tests/core/contract/verification-lifecycle
 * Phase 951: archiveAndEmit commit-point behavior
 */
describe('archiveAndEmit (phase 951)', () => {
  function createMockFs(opts: { moveThrow?: Error } = {}): VerificationContext['fs'] {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    function addDir(p: string) {
      let cur = p;
      while (cur && cur !== '/' && cur !== '.') {
        dirs.add(cur);
        cur = path.dirname(cur);
      }
    }
    function isDir(p: string) {
      if (dirs.has(p)) return true;
      // a path is a directory if any file is under it
      for (const f of files.keys()) {
        if (f.startsWith(p + '/')) return true;
      }
      return false;
    }
    return {
      exists: vi.fn(async (p: string) => files.has(p) || isDir(p)),
      existsSync: vi.fn((p: string) => files.has(p) || isDir(p)),
      read: vi.fn(async (p: string) => {
        if (!files.has(p)) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return files.get(p)!;
      }),
      writeExclusive: vi.fn(async (p: string, content: string) => {
        if (files.has(p)) {
          const err = new Error('EEXIST') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        addDir(path.dirname(p));
        files.set(p, content);
      }),
      writeAtomic: vi.fn(async (p: string, content: string) => {
        addDir(path.dirname(p));
        files.set(p, content);
      }),
      ensureDir: vi.fn(async (p: string) => {
        addDir(p);
      }),
      move: vi.fn(async (src: string, dst: string) => {
        if (opts.moveThrow) throw opts.moveThrow;
        const srcDir = isDir(src);
        const entries: Array<[string, string]> = [];
        if (srcDir) {
          for (const [k, v] of files.entries()) {
            if (k === src || k.startsWith(src + '/')) {
              entries.push([k, v]);
            }
          }
        } else if (files.has(src)) {
          entries.push([src, files.get(src)!]);
        }
        if (entries.length === 0) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        for (const [k, v] of entries) {
          const relative = k.slice(src.length);
          const newKey = dst + relative;
          addDir(path.dirname(newKey));
          files.set(newKey, v);
          files.delete(k);
        }
        dirs.delete(src);
        addDir(dst);
      }),
      moveDir: vi.fn(async (src: string, dst: string) => {
        if (opts.moveThrow) throw opts.moveThrow;
        const entries: Array<[string, string]> = [];
        for (const [k, v] of files.entries()) {
          if (k === src || k.startsWith(src + '/')) {
            entries.push([k, v]);
          }
        }
        if (entries.length === 0) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        for (const [k, v] of entries) {
          const relative = k.slice(src.length);
          const newKey = dst + relative;
          addDir(path.dirname(newKey));
          files.set(newKey, v);
          files.delete(k);
        }
        dirs.delete(src);
        addDir(dst);
      }),
      list: vi.fn(async () => []),
      listSync: vi.fn(() => []),
      removeDir: vi.fn(async () => {}),
      deleteFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ mtime: new Date() } as any)),
    } as unknown as VerificationContext['fs'];
  }

  function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
    return {
      clawDir: '/tmp/claw',
      clawId: 'claw-test',
      baseDir: '/tmp/claw',
      activeDir: '/tmp/claw/contract/active',
      archiveDir: '/tmp/claw/contract/archive' as any,
      fs: createMockFs(),
      abortContractVerifiers: vi.fn(),
      audit: {
        __brand: 'AuditLog',
        write: vi.fn(),
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      } as unknown as VerificationContext['audit'],
      notifyClaw: vi.fn(),
      onNotify: vi.fn(),
      emitContractCompleted: vi.fn(),
      getProgress: vi.fn().mockResolvedValue(null),
      saveProgress: vi.fn(),
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

  it('does not call handler when precondition fails', async () => {
    const contractId = makeContractId('c-1');
    vi.mocked(ctx.getProgress).mockResolvedValue({
      contract_id: contractId,
      status: 'running',
      subtasks: { t1: { status: 'todo' } },
    } as any);
    vi.mocked(ctx.checkAllSubtasksCompleted).mockResolvedValue(false);

    const result = await archiveAndEmit(ctx, contractId, contractYaml, 'test-context');

    expect(result).toEqual({ archived: false });
    expect(ctx.emitContractCompleted).not.toHaveBeenCalled();
    expect(ctx.saveProgress).not.toHaveBeenCalled();

    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED)).toBe(true);
  });

  it('handler called zero times before rename and exactly once after successful commit', async () => {
    const fs = createMockFs();
    const contractId = makeContractId('c-2');
    const activeRoot = `/tmp/claw/contract/active/${contractId}`;
    const archiveRoot = `/tmp/claw/contract/archive/completed/${contractId}`;
    // Seed active contract dir so move succeeds
    await fs.writeAtomic(`${activeRoot}/contract.yaml`, 'yaml');
    vi.mocked(ctx.getProgress).mockResolvedValue({
      contract_id: contractId,
      status: 'completed',
      subtasks: { t1: { status: 'completed', completed_at: '2026-07-27T00:00:00Z' } },
    } as any);
    vi.mocked(ctx.checkAllSubtasksCompleted).mockResolvedValue(true);

    const result = await archiveAndEmit({ ...ctx, fs }, contractId, contractYaml, 'test-context');

    expect(result).toEqual({ archived: true, state: 'completed' });
    expect(await fs.exists(archiveRoot)).toBe(true);
    // handler called exactly once, after rename
    expect(ctx.emitContractCompleted).toHaveBeenCalledTimes(1);
    expect(ctx.emitContractCompleted).toHaveBeenCalledWith(contractId);
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.COMPLETED)).toBe(true);
    expect(ctx.onNotify).toHaveBeenCalled();
  });

  it('records verifier abort failure on the completed audit without breaking side effects', async () => {
    const fs = createMockFs();
    const contractId = makeContractId('c-abort-throw');
    const activeRoot = `/tmp/claw/contract/active/${contractId}`;
    await fs.writeAtomic(`${activeRoot}/contract.yaml`, 'yaml');
    vi.mocked(ctx.getProgress).mockResolvedValue({
      contract_id: contractId,
      status: 'completed',
      subtasks: { t1: { status: 'completed', completed_at: '2026-07-27T00:00:00Z' } },
    } as any);
    vi.mocked(ctx.checkAllSubtasksCompleted).mockResolvedValue(true);
    vi.mocked(ctx.abortContractVerifiers).mockImplementation(() => {
      throw new Error('abort boom');
    });

    const result = await archiveAndEmit({ ...ctx, fs }, contractId, contractYaml, 'test-context');

    expect(result).toEqual({ archived: true, state: 'completed' });
    // Commit stands; the remaining success side effects still fire exactly once.
    expect(ctx.emitContractCompleted).toHaveBeenCalledTimes(1);
    expect(ctx.onNotify).toHaveBeenCalled();
    // The abort failure is recorded on the completed audit, not swallowed.
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    const completedCalls = auditWrites.filter(c => c[0] === CONTRACT_AUDIT_EVENTS.COMPLETED);
    expect(completedCalls.some(c =>
      c.some(col => String(col).startsWith('abort_verifier_failed=') && String(col).includes('abort boom')),
    )).toBe(true);
  });

  it('returns lost_to_state when cancel won the race', async () => {
    const fs = createMockFs();
    const contractId = makeContractId('c-3');
    const cancelledRoot = `/tmp/claw/contract/archive/cancelled/${contractId}`;
    // Contract already in cancelled archive (lost the race)
    await fs.ensureDir(`/tmp/claw/contract/archive/cancelled`);
    await fs.writeAtomic(`${cancelledRoot}/contract.yaml`, 'yaml');
    vi.mocked(ctx.getProgress).mockResolvedValue({
      contract_id: contractId,
      status: 'completed',
      subtasks: { t1: { status: 'completed', completed_at: '2026-07-27T00:00:00Z' } },
    } as any);
    vi.mocked(ctx.checkAllSubtasksCompleted).mockResolvedValue(true);

    const result = await archiveAndEmit({ ...ctx, fs }, contractId, contractYaml, 'test-context');

    expect(result).toEqual({ archived: false, state: 'cancelled' });
    expect(ctx.emitContractCompleted).not.toHaveBeenCalled();
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED)).toBe(true);
  });

  it('returns retryable_failure when move fails and contract stays active', async () => {
    const fs = createMockFs({ moveThrow: new Error('disk full') });
    const contractId = makeContractId('c-4');
    const activeRoot = `/tmp/claw/contract/active/${contractId}`;
    await fs.writeAtomic(`${activeRoot}/contract.yaml`, 'yaml');
    vi.mocked(ctx.getProgress).mockResolvedValue({
      contract_id: contractId,
      status: 'completed',
      subtasks: { t1: { status: 'completed', completed_at: '2026-07-27T00:00:00Z' } },
    } as any);
    vi.mocked(ctx.checkAllSubtasksCompleted).mockResolvedValue(true);

    const result = await archiveAndEmit({ ...ctx, fs }, contractId, contractYaml, 'test-context');

    expect(result).toEqual({ archived: false });
    expect(ctx.emitContractCompleted).not.toHaveBeenCalled();
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED)).toBe(true);
    expect(ctx.saveProgress).not.toHaveBeenCalled();
  });
});

/**
 * @module tests/core/contract/verification-pipeline-race
 * Phase 1371 sub-3: completeSubtaskSync vs runVerificationPipeline 并发拒绝
 * （Phase 1201 Step D：由 queued fresh-read start transition 决定，内存闸门已删除）
 */
describe('verification pipeline concurrent reject (phase 1371 sub-3 / 1201 step D)', () => {
  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-verification-pipeline-race-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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

    // Phase 1201 Step D：内存闸门已删除。第一次 await 返后、background work 仍跑
    // （mocked 死锁 promise），subtask 保持 in_progress。第二次 completeSubtask 的
    // queued fresh-read start transition 见 status=in_progress → skipped → ToolError。
    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });

    await expect(
      completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e2' })
    ).rejects.toThrow(/Cannot start verification/);
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

    // First failure (wait for background done before next call to avoid concurrent reject)
    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    // Second failure → force-accept (retry_count reaches verification_attempts=2)
    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e2' });
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
    const result = await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });

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
    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });

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
    const progress = await manager.getProgress(contractId);
    progress.subtasks['t1'].status = 'completed';
    progress.subtasks['t1'].completed_at = new Date().toISOString();
    await (manager as any).saveActiveProgressExisting(contractId, progress);

    // Spy fs.moveDir to throw (simulating archive failure)
    vi.spyOn(nodeFs, 'moveDir').mockRejectedValue(new Error('disk full'));

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
    const savedProgress = JSON.parse(raw);
    expect(savedProgress.status).toBeUndefined();
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
      persistVerificationOutcome: vi.fn().mockResolvedValue('persisted'),
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

    const result = await handleVerificationErrorRetry(ctx, contractId, subtaskId, 'programming_bug', 'crash');

    expect(saveProgress).not.toHaveBeenCalled();
    expect(progress.subtasks[subtaskId].status).toBe('in_progress');
    expect(result.disposition).toEqual({ kind: 'not_applied', reason: 'not_active' });
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
        [subtaskId]: { status: 'in_progress', retry_count: 0, verification_attempt_id: 'att-1' },
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

    const result = await handleVerificationErrorRetry(ctx, contractId, subtaskId, 'programming_bug', 'crash');

    expect(transitionVerificationAttempt).toHaveBeenCalledWith(
      contractId,
      subtaskId,
      expect.objectContaining({ kind: 'reject', cause: 'programming_bug', maxAttempts: 3 }),
    );
    expect(updatedProgress.subtasks[subtaskId].status).toBe('todo');
    expect(updatedProgress.subtasks[subtaskId].retry_count).toBe(1);
    // phase 1829: 返回真实 disposition（含绑定 attempt 与已提交计数）
    expect(result.disposition).toEqual({ kind: 'returned_to_todo', attemptId: 'att-1', retryCount: 1 });
    expect(result.processingErrors).toEqual([]);
  });

  it('transition late → not_applied/late with actualAttemptId, no retry side effects', async () => {
    const ctx = makeCtx({
      getProgress: vi.fn().mockResolvedValue({
        subtasks: { st1: { status: 'in_progress', retry_count: 0, verification_attempt_id: 'att-old' } },
      }),
      transitionVerificationAttempt: vi.fn().mockResolvedValue({
        kind: 'late', expectedAttemptId: 'att-old', actualAttemptId: 'att-new',
      }),
    });

    const result = await handleVerificationErrorRetry(ctx, 'c1', 'st1', 'programming_bug', 'crash', 'att-old');

    expect(result.disposition).toEqual({ kind: 'not_applied', reason: 'late', actualAttemptId: 'att-new' });
    expect(result.processingErrors).toEqual([]);
  });

  it('immutable outcome conflict → not_applied/conflict, no transition', async () => {
    const transitionVerificationAttempt = vi.fn();
    const ctx = makeCtx({
      getProgress: vi.fn().mockResolvedValue({
        subtasks: { st1: { status: 'in_progress', retry_count: 0, verification_attempt_id: 'att-1' } },
      }),
      persistVerificationOutcome: vi.fn().mockResolvedValue('conflict'),
      transitionVerificationAttempt,
    });

    const result = await handleVerificationErrorRetry(
      ctx, 'c1', 'st1', 'programming_bug', 'crash', 'att-1',
      { message: 'boom', name: 'Error' },
    );

    expect(result.disposition).toEqual({ kind: 'not_applied', reason: 'conflict' });
    expect(transitionVerificationAttempt).not.toHaveBeenCalled();
  });

  it('subtask not in_progress → not_applied/not_in_progress with observed status', async () => {
    const ctx = makeCtx({
      getProgress: vi.fn().mockResolvedValue({
        subtasks: { st1: { status: 'completed', retry_count: 3 } },
      }),
    });

    const result = await handleVerificationErrorRetry(ctx, 'c1', 'st1', 'programming_bug', 'crash');

    expect(result.disposition).toEqual({ kind: 'not_applied', reason: 'not_in_progress', observedStatus: 'completed' });
  });

  it('gateway throw → fallback interrupt on the SAME bound attempt → interrupted_to_todo', async () => {
    const transitionVerificationAttempt = vi.fn().mockImplementation((_c: string, _s: string, t: any) => {
      if (t.kind === 'reject') return Promise.reject(new Error('gateway write failed'));
      return Promise.resolve({
        kind: 'updated',
        progress: { subtasks: { st1: { status: 'todo', retry_count: 2 } } },
      });
    });
    const ctx = makeCtx({
      getProgress: vi.fn().mockResolvedValue({
        subtasks: { st1: { status: 'in_progress', retry_count: 2, verification_attempt_id: 'att-1' } },
      }),
      transitionVerificationAttempt,
    });

    const result = await handleVerificationErrorRetry(ctx, 'c1', 'st1', 'programming_bug', 'crash', 'att-1');

    expect(result.disposition).toEqual({ kind: 'interrupted_to_todo', attemptId: 'att-1', retryCount: 2 });
    // 原始处理异常保留在 processingErrors，不覆盖
    expect(result.processingErrors.join('\n')).toContain('gateway write failed');
    const interruptCalls = transitionVerificationAttempt.mock.calls.filter(([, , t]: any) => t.kind === 'interrupt');
    expect(interruptCalls).toHaveLength(1);
    expect(interruptCalls[0][2]).toMatchObject({ attemptId: 'att-1' });
  });

  it('fallback fresh-read finds a NEW attempt → does NOT interrupt it, reports late', async () => {
    const transitionVerificationAttempt = vi.fn().mockImplementation((_c: string, _s: string, t: any) => {
      if (t.kind === 'reject') return Promise.reject(new Error('gateway write failed'));
      return Promise.resolve({ kind: 'updated', progress: { subtasks: {} } });
    });
    const ctx = makeCtx({
      getProgress: vi.fn().mockResolvedValue({
        subtasks: { st1: { status: 'in_progress', retry_count: 0, verification_attempt_id: 'att-NEW' } },
      }),
      transitionVerificationAttempt,
    });

    const result = await handleVerificationErrorRetry(ctx, 'c1', 'st1', 'programming_bug', 'crash', 'att-old');

    expect(result.disposition).toEqual({ kind: 'not_applied', reason: 'late', actualAttemptId: 'att-NEW' });
    const interruptCalls = transitionVerificationAttempt.mock.calls.filter(([, , t]: any) => t.kind === 'interrupt');
    expect(interruptCalls).toHaveLength(0);
  });

  it('fallback also throws → unconfirmed keeps both original and processing errors', async () => {
    const transitionVerificationAttempt = vi.fn().mockRejectedValue(new Error('gateway down'));
    const ctx = makeCtx({
      getProgress: vi.fn().mockResolvedValue({
        subtasks: { st1: { status: 'in_progress', retry_count: 0, verification_attempt_id: 'att-1' } },
      }),
      transitionVerificationAttempt,
    });

    const result = await handleVerificationErrorRetry(ctx, 'c1', 'st1', 'programming_bug', 'crash', 'att-1');

    expect(result.disposition.kind).toBe('unconfirmed');
    expect(result.processingErrors.length).toBeGreaterThanOrEqual(2);
    expect(result.processingErrors.join('\n')).toContain('gateway down');
  });

  it('post-commit side-effect failure does not rewrite committed disposition or re-reject', async () => {
    const audit = makeMockAudit();
    vi.mocked(audit.write).mockImplementation((type: string) => {
      if (type === CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO) throw new Error('audit disk full');
    });
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'updated',
      progress: { subtasks: { st1: { status: 'todo', retry_count: 1 } } },
    });
    const ctx = makeCtx({
      audit: audit as unknown as VerificationContext['audit'],
      getProgress: vi.fn().mockResolvedValue({
        subtasks: { st1: { status: 'in_progress', retry_count: 0, verification_attempt_id: 'att-1' } },
      }),
      transitionVerificationAttempt,
    });

    const result = await handleVerificationErrorRetry(ctx, 'c1', 'st1', 'programming_bug', 'crash', 'att-1');

    // 已提交处置保留为 returned_to_todo；副作用失败只追加 processingErrors
    expect(result.disposition).toEqual({ kind: 'returned_to_todo', attemptId: 'att-1', retryCount: 1 });
    expect(result.processingErrors.join('\n')).toContain('audit disk full');
    // 没有第二次 reject / fallback interrupt
    expect(transitionVerificationAttempt).toHaveBeenCalledTimes(1);
  });

  it('force-accept on threshold → disposition carries counts; no inbox written inside handler', async () => {
    const notifyClaw = vi.fn();
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'updated',
      progress: {
        subtasks: {
          st1: {
            status: 'completed', retry_count: 3, force_accepted: true,
            last_failed_feedback: { feedback: 'crash', cause: 'programming_bug' },
          },
        },
      },
    });
    const ctx = makeCtx({
      notifyClaw,
      getProgress: vi.fn().mockResolvedValue({
        subtasks: { st1: { status: 'in_progress', retry_count: 2, verification_attempt_id: 'att-1' } },
      }),
      transitionVerificationAttempt,
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(true),
    });

    const result = await handleVerificationErrorRetry(ctx, 'c1', 'st1', 'programming_bug', 'crash', 'att-1');

    expect(result.disposition).toEqual({
      kind: 'force_accepted', attemptId: 'att-1', retryCount: 3, maxAttempts: 3,
      allCompleted: true, feedback: 'crash',
    });
    // archived=false 投影保留旧 caller「放行后需尝试归档」约定
    expect(result.archived).toBe(false);
    // phase 1829: force-accept inbox 由 writeVerificationError 依据 disposition 统一发出
    expect(notifyClaw).not.toHaveBeenCalled();
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