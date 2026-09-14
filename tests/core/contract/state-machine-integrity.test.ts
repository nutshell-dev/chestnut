/**
 * Phase 1038 C-3 Contract state machine integrity (W3-B α-1+α-4+α-7)
 * Phase 1132 Step D 调整：目录 rename 是 lifecycle 唯一提交点；archive 失败时不 rollback status，
 * 也不进入 archive_pending_recovery，仅 audit 并保持 active。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { archiveAndEmit, writeVerificationError } from '../../../src/core/contract/verification.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

import type { VerificationContext } from '../../../src/core/contract/verification.js';
import type { ProgressData } from '../../../src/core/contract/types.js';
import type { ContractNotification } from '../../../src/core/contract/notification.js';

function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

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

function makeAcceptanceCtx(
  overrides: {
    moveToArchiveThrows?: boolean;
    saveProgressThrows?: boolean;
    maxAttempts?: number;
    progress?: ProgressData;
  } = {},
): { ctx: VerificationContext; events: Array<[string, ...(string | number)[]]>; notifyCalls: ContractNotification[] } {
  const { audit, events } = makeAudit();
  const notifyCalls: ContractNotification[] = [];

  const storedProgress: Record<string, ProgressData> = {};
  const fsMock = createMockFs({ moveThrow: overrides.moveToArchiveThrows ? new Error('disk full') : undefined });

  const ctx: VerificationContext = {
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    baseDir: '/tmp/claw',
    activeDir: '/tmp/claw/contract/active',
    archiveDir: '/tmp/claw/contract/archive' as any,
    abortContractVerifiers: vi.fn(),
    audit,
    notifyClaw: vi.fn(),
    contractDir: vi.fn(async (_id: string) => `contract/active`),
    loadContractYaml: vi.fn(async (id: string) => ({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 'st1', description: 'ST1' }],
      verification_attempts: overrides.maxAttempts,
    })),
    getProgress: vi.fn(async (id: string) => {
      return storedProgress[id] ?? {
        contract_id: id,
        status: 'running',
        subtasks: {},
      };
    }),
    saveProgress: vi.fn(async (id: string, p: ProgressData) => {
      if (overrides.saveProgressThrows) {
        throw new Error('saveProgress mock error');
      }
      storedProgress[id] = p;
    }),
    checkAllSubtasksCompleted: vi.fn(async () => false),
    emitContractCompleted: vi.fn(async () => {}),
    onNotify: (event: ContractNotification) => {
      notifyCalls.push(event);
    },
    runScriptVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
    runLLMVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
    toolRegistry: createToolRegistry(),
    runVerifierWithCancel: vi.fn(async () => ({ passed: true, feedback: '' })),
    fs: fsMock,
    isActiveContract: vi.fn(async () => true),
    getContractRoot: vi.fn(async (_id: string) => `contract/active/${_id}`),
    persistVerificationOutcome: vi.fn(async () => 'persisted'),
    transitionVerificationAttempt: vi.fn(async (contractId: string, subtaskId: string, transition: any) => {
      const current = storedProgress[contractId] ?? {
        contract_id: contractId,
        status: 'running',
        subtasks: {},
      };
      const sub = current.subtasks[subtaskId] ?? { status: 'in_progress', retry_count: 0 };
      if (transition.kind === 'reject') {
        const retryCount = (sub.retry_count ?? 0) + 1;
        // Phase 1201 Step B: forceAccept 由 queued mutation 基于 fresh retry_count 计算
        const forceAccept = retryCount >= transition.maxAttempts;
        const updatedSub = {
          ...sub,
          status: forceAccept ? ('completed' as const) : ('todo' as const),
          retry_count: retryCount,
          ...(forceAccept ? { force_accepted: true } : {}),
          ...(forceAccept ? {} : { last_failed_feedback: { feedback: transition.feedback, cause: transition.cause, at: transition.at } }),
        };
        const updatedProgress = {
          ...current,
          subtasks: { ...current.subtasks, [subtaskId]: updatedSub },
        };
        storedProgress[contractId] = updatedProgress;
        return { kind: 'updated', record: {} as any, progress: updatedProgress };
      }
      return { kind: 'updated', record: {} as any, progress: current };
    }),
  };

  return { ctx, events, notifyCalls, storedProgress };
}

describe('phase 1038 C-3 Contract state machine integrity (W3-B α-1+α-4+α-7)', () => {
  describe('α-1 archiveAndEmit failure does not revert progress.status', () => {
    it('archive fail → no progress save, no status rollback, returns archived=false', async () => {
      const { ctx, events } = makeAcceptanceCtx({ moveToArchiveThrows: true });
      // setup: contract with all subtasks completed
      (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        contract_id: 'c1',
        status: 'completed',
        subtasks: { st1: { status: 'completed', completed_at: '2026-07-27T00:00:00Z' } },
      });
      (ctx.checkAllSubtasksCompleted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

      const result = await archiveAndEmit(ctx, 'c1', 'Test', 'test');

      expect(result).toEqual({ archived: false });
      // no saveProgress call after failed move
      expect(ctx.saveProgress).not.toHaveBeenCalled();

      // audit emit MOVE_ARCHIVE_FAILED
      const moveArchiveFails = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
      expect(moveArchiveFails.length).toBeGreaterThanOrEqual(1);
    });

    it('archive success → intent persisted + handler called after rename + contract_completed fires', async () => {
      const { ctx, notifyCalls } = makeAcceptanceCtx({ moveToArchiveThrows: false });
      const contractId = 'c2';
      (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        contract_id: contractId,
        status: 'completed',
        subtasks: { st1: { status: 'completed', completed_at: '2026-07-27T00:00:00Z' } },
      });
      (ctx.checkAllSubtasksCompleted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
      // seed active contract so move succeeds
      await ctx.fs.writeAtomic(`/tmp/claw/contract/active/${contractId}/contract.yaml`, 'yaml');

      const result = await archiveAndEmit(ctx, contractId, 'Test', 'test');

      expect(result).toEqual({ archived: true, state: 'completed' });
      expect(ctx.emitContractCompleted).toHaveBeenCalledTimes(1);
      expect(ctx.emitContractCompleted).toHaveBeenCalledWith(contractId);
      expect(notifyCalls).toContainEqual(expect.objectContaining({ type: 'contract_completed' }));
    });

    it('archive fail + saveProgress fail → still returns archived=false and emits MOVE_ARCHIVE_FAILED', async () => {
      // Phase 1132 Step D: no rollback, no archive_pending_recovery; failure is just audited.
      const { ctx, events } = makeAcceptanceCtx({ moveToArchiveThrows: true, saveProgressThrows: true });
      (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        contract_id: 'c3',
        status: 'completed',
        subtasks: { st1: { status: 'completed', completed_at: '2026-07-27T00:00:00Z' } },
      });
      (ctx.checkAllSubtasksCompleted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

      const result = await archiveAndEmit(ctx, 'c3', 'Test', 'test');

      expect(result).toEqual({ archived: false });
      const moveArchiveFails = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
      expect(moveArchiveFails.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('α-4 writeVerificationError reset path force-accept check', () => {
    it('reset path retry_count >= maxAttempts → force_accepted + SUBTASK_FORCE_ACCEPTED audit', async () => {
      const { ctx, events, storedProgress } = makeAcceptanceCtx({ maxAttempts: 3 });
      // setup: subtask with retry_count=2 + in_progress
      storedProgress.c1 = {
        contract_id: 'c1',
        status: 'running',
        subtasks: {
          st1: { status: 'in_progress', retry_count: 2 },
        },
      };

      await writeVerificationError(ctx, 'c1', 'st1', new Error('test'));

      const txCalls = (ctx.transitionVerificationAttempt as ReturnType<typeof vi.fn>).mock.calls;
      expect(txCalls.length).toBeGreaterThanOrEqual(1);
      expect(txCalls[0][2]).toMatchObject({ kind: 'reject', maxAttempts: 3 });
      expect(storedProgress.c1.subtasks['st1'].force_accepted).toBe(true);

      expect(events).toContainEqual(expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED,
        expect.stringContaining('contractId=c1'),
        expect.stringContaining('subtaskId=st1'),
        expect.stringContaining('retry_count=3'),
        expect.stringContaining('claw=claw-test'),
      ]));

      // phase 1829: 异常后放行只发一条 verification_result，同时携带异常与放行事实；
      // 不再另发一条会要求重试的 verification_error。
      const notifyClawCalls = (ctx.notifyClaw as ReturnType<typeof vi.fn>).mock.calls;
      expect(notifyClawCalls).toHaveLength(1);
      const msg = notifyClawCalls[0][1];
      expect(msg.type).toBe('verification_result');
      expect(msg.extraFields.force_accepted).toBe('true');
      expect(msg.extraFields.retry_count).toBe('3');
      expect(msg.body).toContain('契约：c1；子任务：st1');
      expect(msg.body).toContain('未得到正常通过结论');
      expect(msg.body).toContain('失败计数达到配置阈值 3');
      expect(msg.body).toContain('test');
    });

    it('reset path retry_count < maxAttempts → force_accepted unset + 单条 verification_error', async () => {
      const { ctx, storedProgress } = makeAcceptanceCtx({ maxAttempts: 3 });
      // setup: subtask with retry_count=0 + in_progress
      storedProgress.c2 = {
        contract_id: 'c2',
        status: 'running',
        subtasks: {
          st1: { status: 'in_progress', retry_count: 0 },
        },
      };

      await writeVerificationError(ctx, 'c2', 'st1', new Error('test'));

      const txCalls = (ctx.transitionVerificationAttempt as ReturnType<typeof vi.fn>).mock.calls;
      expect(txCalls.length).toBeGreaterThanOrEqual(1);
      expect(txCalls[0][2]).toMatchObject({ kind: 'reject', maxAttempts: 3 });
      expect(storedProgress.c2.subtasks['st1'].force_accepted).toBeUndefined();

      // phase 1829: 异常退回只发一条 verification_error，含身份与已退回处置
      const notifyClawCalls = (ctx.notifyClaw as ReturnType<typeof vi.fn>).mock.calls;
      expect(notifyClawCalls).toHaveLength(1);
      const msg = notifyClawCalls[0][1];
      expect(msg.type).toBe('verification_error');
      expect(msg.body).toContain('契约：c2；子任务：st1');
      expect(msg.body).toContain('系统已将该子任务退回待提交');
      expect(msg.body).toContain('当前已提交失败计数：1');
    });

    it('reset path with no verification_attempts config → uses default maxAttempts=3', async () => {
      const { ctx, events, storedProgress } = makeAcceptanceCtx({ /* no maxAttempts override */ });
      // setup: subtask with retry_count=3 (default maxAttempts=3) → should force-accept
      storedProgress.c3 = {
        contract_id: 'c3',
        status: 'running',
        subtasks: {
          st1: { status: 'in_progress', retry_count: 3 },
        },
      };
      // loadContractYaml returns no escalation config
      (ctx.loadContractYaml as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 'st1', description: 'ST1' }],
      });

      await writeVerificationError(ctx, 'c3', 'st1', new Error('test'));

      const txCalls = (ctx.transitionVerificationAttempt as ReturnType<typeof vi.fn>).mock.calls;
      expect(txCalls.length).toBeGreaterThanOrEqual(1);
      expect(txCalls[0][2]).toMatchObject({ kind: 'reject', maxAttempts: 3 });
      expect(storedProgress.c3.subtasks['st1'].force_accepted).toBe(true);

      expect(events).toContainEqual(expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED,
      ]));
    });
  });

  describe('α-7 manager.create() throw on archive failure', () => {
    let tempDir: string;
    let clawDir: string;
    let auditCalls: Array<[string, ...(string | number)[]]>;

    beforeEach(async () => {
      tempDir = await createTempDir();
      clawDir = path.join(tempDir, 'claws', 'test-claw');
      await fs.mkdir(clawDir, { recursive: true });
      auditCalls = [];
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupTempDir(tempDir);
    });

    function makeManager(overrides: { moveToArchiveThrows?: boolean } = {}) {
      const nodeFs = new NodeFileSystem({ baseDir: clawDir });
      const audit = {
        write: (type: string, ...args: (string | number)[]) => {
          auditCalls.push([type, ...args]);
        },
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      };
      const manager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: audit as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
      });
      if (overrides.moveToArchiveThrows) {
        vi.spyOn(manager as any, 'moveToArchive').mockRejectedValue(new Error('archive mock error'));
      }
      return { manager, nodeFs };
    }

    it('existing active contract → second create succeeds and both directories exist', async () => {
      // create existing active contract c1
      const { manager: mgr0 } = makeManager();
      await mgr0.create(makeContractYaml({ id: 'c1', title: 'Existing' }));

      // now create c2 while c1 is still active
      const { manager, nodeFs } = makeManager();
      // share same fs so c1 exists
      (manager as any).fs = nodeFs;

      const id = await manager.create(makeContractYaml({ id: 'c2', title: 'New' }));
      expect(id).toBe('c2');

      // verify both active directories exist
      expect(await nodeFs.exists('contract/active/c1')).toBe(true);
      expect(await nodeFs.exists('contract/active/c2')).toBe(true);
    });

    it('active released → new contract created normally', async () => {
      // create existing active contract c1 and cancel it to release capacity
      const { manager: mgr0 } = makeManager();
      await mgr0.create(makeContractYaml({ id: 'c1', title: 'Existing' }));
      await mgr0.cancel('c1', 'release capacity');

      const { manager, nodeFs } = makeManager();
      (manager as any).fs = nodeFs;

      const id = await manager.create(makeContractYaml({ id: 'c2', title: 'New' }));
      expect(id).toBe('c2');

      const c2Exists = await nodeFs.exists('contract/active/c2');
      expect(c2Exists).toBe(true);
    });

    it('no existing active contract → create new (no archive needed)', async () => {
      const { manager } = makeManager();
      const id = await manager.create(makeContractYaml({ id: 'c1', title: 'First' }));
      expect(id).toBe('c1');
    });
  });
});
