/**
 * Phase 1038 C-3 Contract state machine integrity (W3-B α-1+α-4+α-7)
 * audit-2026-05-17 §C-3 closure
 *
 * 反向 9 项: 3 sub-fix × 3 case each
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

function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
  return { audit, events };
}

function makeAcceptanceCtx(
  overrides: {
    moveToArchiveThrows?: boolean;
    saveProgressThrows?: boolean;
    maxAttempts?: number;
    progress?: ProgressData;
  } = {},
): { ctx: VerificationContext; events: Array<[string, ...(string | number)[]]>; notifyCalls: Array<{ type: string; data: Record<string, unknown> }> } {
  const { audit, events } = makeAudit();
  const notifyCalls: Array<{ type: string; data: Record<string, unknown> }> = [];

  const storedProgress: Record<string, ProgressData> = {};

  const ctx: VerificationContext = {
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    audit,
    contractDir: vi.fn(async (id: string) => `contract/active/${id}`),
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
    moveContractToArchive: vi.fn(async () => {
      if (overrides.moveToArchiveThrows) {
        throw new Error('moveToArchive mock error');
      }
    }),
    emitContractCompleted: vi.fn(async () => {}),
    onNotify: (type: string, data: Record<string, unknown>) => {
      notifyCalls.push({ type, data });
    },
    runScriptVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
    runLLMVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
    withProgressLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    toolRegistry: createToolRegistry(),
    runVerifierWithCancel: vi.fn(async () => ({ passed: true, feedback: '' })),
    fs: {
      exists: vi.fn(async () => true),
      existsSync: vi.fn(() => true),
      read: vi.fn(async () => ''),
      writeAtomic: vi.fn(async () => {}),
      removeDir: vi.fn(async () => {}),
      ensureDir: vi.fn(async () => {}),
    } as unknown as VerificationContext['fs'],
  };

  return { ctx, events, notifyCalls };
}

describe('phase 1038 C-3 Contract state machine integrity (W3-B α-1+α-4+α-7)', () => {
  describe('α-1 archiveAndEmit failure reverts progress.status', () => {
    it('archive fail → progress.status reverts from completed to running', async () => {
      const { ctx, events } = makeAcceptanceCtx({ moveToArchiveThrows: true });
      // setup: contract with status='completed'
      (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        contract_id: 'c1',
        status: 'completed',
        subtasks: { st1: { status: 'completed' } },
      });

      await archiveAndEmit(ctx, 'c1', 'Test', 'test');

      // verify saveProgress called with status='running'
      const saveCalls = (ctx.saveProgress as ReturnType<typeof vi.fn>).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedProgress = saveCalls[0][1] as ProgressData;
      expect(savedProgress.status).toBe('running');

      // audit emit MOVE_ARCHIVE_FAILED with revert message
      const moveArchiveFails = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
      expect(moveArchiveFails.length).toBeGreaterThanOrEqual(1);
      expect(moveArchiveFails.some(e =>
        e.some(col => typeof col === 'string' && col.includes('reverted to running'))
      )).toBe(true);
    });

    it('archive success → progress.status stays completed + contract_completed fires', async () => {
      const { ctx, notifyCalls } = makeAcceptanceCtx({ moveToArchiveThrows: false });
      await archiveAndEmit(ctx, 'c2', 'Test', 'test');

      expect(ctx.moveContractToArchive).toHaveBeenCalledWith('c2');
      expect(notifyCalls).toContainEqual(expect.objectContaining({ type: 'contract_completed' }));
    });

    it('revert itself fails → original archive error preserved + partial recovery audit (best-effort)', async () => {
      const { ctx, events } = makeAcceptanceCtx({ moveToArchiveThrows: true, saveProgressThrows: true });
      (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        contract_id: 'c3',
        status: 'completed',
        subtasks: {},
      });

      await archiveAndEmit(ctx, 'c3', 'Test', 'test');

      // phase 1371 sub-2: revert failure now emits ARCHIVE_PARTIAL_RECOVERY_FAILED + sets archive_pending_recovery
      const moveArchiveFails = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
      expect(moveArchiveFails.length).toBeGreaterThanOrEqual(1);
      const partialRecoveryEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PARTIAL_RECOVERY_FAILED);
      expect(partialRecoveryEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('α-4 writeVerificationError reset path force-accept check', () => {
    it('reset path retry_count >= maxAttempts → force_accepted + SUBTASK_FORCE_ACCEPTED audit', async () => {
      const { ctx, events } = makeAcceptanceCtx({ maxAttempts: 3 });
      // setup: subtask with retry_count=2 + in_progress
      (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        contract_id: 'c1',
        status: 'running',
        subtasks: {
          st1: { status: 'in_progress', retry_count: 2 },
        },
      });

      await writeVerificationError(ctx, 'c1', 'st1', new Error('test'));

      const saveCalls = (ctx.saveProgress as ReturnType<typeof vi.fn>).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedProgress = saveCalls[0][1] as ProgressData;
      expect(savedProgress.subtasks['st1'].force_accepted).toBe(true);

      expect(events).toContainEqual(expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED,
        expect.stringContaining('contractId=c1'),
        expect.stringContaining('subtaskId=st1'),
        expect.stringContaining('retry_count=3'),
        expect.stringContaining('claw=claw-test'),
      ]));
    });

    it('reset path retry_count < maxAttempts → force_accepted unset', async () => {
      const { ctx } = makeAcceptanceCtx({ maxAttempts: 3 });
      // setup: subtask with retry_count=0 + in_progress
      (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        contract_id: 'c2',
        status: 'running',
        subtasks: {
          st1: { status: 'in_progress', retry_count: 0 },
        },
      });

      await writeVerificationError(ctx, 'c2', 'st1', new Error('test'));

      const saveCalls = (ctx.saveProgress as ReturnType<typeof vi.fn>).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedProgress = saveCalls[0][1] as ProgressData;
      expect(savedProgress.subtasks['st1'].force_accepted).toBeUndefined();
    });

    it('reset path with no verification_attempts config → uses default maxAttempts=3', async () => {
      const { ctx, events } = makeAcceptanceCtx({ /* no maxAttempts override */ });
      // setup: subtask with retry_count=3 (default maxAttempts=3) → should force-accept
      (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        contract_id: 'c3',
        status: 'running',
        subtasks: {
          st1: { status: 'in_progress', retry_count: 3 },
        },
      });
      // loadContractYaml returns no escalation config
      (ctx.loadContractYaml as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 'st1', description: 'ST1' }],
      });

      await writeVerificationError(ctx, 'c3', 'st1', new Error('test'));

      const saveCalls = (ctx.saveProgress as ReturnType<typeof vi.fn>).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedProgress = saveCalls[0][1] as ProgressData;
      expect(savedProgress.subtasks['st1'].force_accepted).toBe(true);

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

    it('previous archive fails → throws ToolError + 0 new contract dir created', async () => {
      // create existing active contract c1
      const { manager: mgr0 } = makeManager();
      await mgr0.create(makeContractYaml({ id: 'c1', title: 'Existing' }));

      // now try to create c2 with archive failing
      const { manager, nodeFs } = makeManager({ moveToArchiveThrows: true });
      // share same fs so c1 exists
      (manager as any).fs = nodeFs;

      await expect(manager.create(makeContractYaml({ id: 'c2', title: 'New' })))
        .rejects.toThrow(/previous active contract "c1" archive failed/);

      // verify c2 dir NOT created
      const c2Exists = await nodeFs.exists('contract/active/c2');
      expect(c2Exists).toBe(false);
    });

    it('previous archive succeeds → new contract created normally', async () => {
      // create existing active contract c1
      const { manager: mgr0 } = makeManager();
      await mgr0.create(makeContractYaml({ id: 'c1', title: 'Existing' }));

      // now create c2 with archive succeeding
      const { manager, nodeFs } = makeManager({ moveToArchiveThrows: false });
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
