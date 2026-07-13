/**
 * phase 946: contract-observer 水位线去重 + async throwing 通知 + 状态损坏 fail-closed 单测
 *
 * 覆盖：
 * - watermark: archivedAt <= lastArchivedAt 跳过
 * - watermark: archivedAt > lastArchivedAt 通知
 * - bootstrap: v1/v2 schema → v3 migration、首 tick 不 emit、只更新水位
 * - first-run: state 不存在、首 tick 不 emit、只更新水位
 * - lastCheckTs 写 tickStart 不是 end-of-scan now
 * - notifyMotion throw → state 不更新
 */
import { makeChestnutRoot } from '../../../src/core/claw-topology/claw-instance-paths.js';
import { describe, it, expect, vi } from 'vitest';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import * as path from 'path';
const TEST_CLAWS_DIR = '/test/root/claws';
const TEST_MOTION_DIR = '/test/root/motion';

interface MockArchiveSpec {
  clawId: string;
  contractId: string;
  status: 'completed' | 'running' | 'cancelled' | 'crashed';
  subtaskCompletedAt: string;  // ISO
}

interface MockFsOpts {
  initialState?: Record<string, unknown> | undefined;  // null = no state file
  archives: MockArchiveSpec[];
}

function createMockFs(opts: MockFsOpts): { fs: FileSystem; writes: Map<string, string> } {
  const writes = new Map<string, string>();
  const fileNotFound = (p: string): Error => {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
  };
  const fs: Partial<FileSystem> = {
    readSync: (p: string) => {
      if (p.includes('contract-observer-state.json')) {
        if (opts.initialState === undefined) throw fileNotFound(p);
        return JSON.stringify(opts.initialState);
      }
      if (p.endsWith('progress.json')) {
        for (const a of opts.archives) {
          if (p.includes(`/${a.clawId}/contract/archive/${a.contractId}/progress.json`)) {
            return JSON.stringify({
              schema_version: 1,
              contract_id: a.contractId,
              status: a.status,
              subtasks: {
                s1: { status: 'completed', completed_at: a.subtaskCompletedAt, evidence: 'mock' },
              },
            });
          }
        }
      }
      throw fileNotFound(p);
    },
    listSync: (p: string, listOpts?: { includeDirs?: boolean }): FileEntry[] => {
      if (p.endsWith('/claws')) {
        const clawSet = new Set(opts.archives.map(a => a.clawId));
        return Array.from(clawSet).map(c => ({ name: c, isDirectory: true, path: `${p}/${c}` }));
      }
      if (p.endsWith('/contract/archive')) {
        const out: FileEntry[] = [];
        for (const a of opts.archives) {
          if (p.includes(`/${a.clawId}/contract/archive`)) {
            out.push({ name: a.contractId, isDirectory: true, path: `${p}/${a.contractId}` });
          }
        }
        return out;
      }
      return [];
    },
    ensureDirSync: vi.fn(),
    writeAtomicSync: (p: string, content: string) => {
      writes.set(p, content);
    },
    existsSync: vi.fn().mockReturnValue(true),
  };
  return { fs: fs as FileSystem, writes };
}

function makeMockTopology(fs: FileSystem, clawsDir: string): ClawTopology {
  return {
    enumerate() {
      const entries = fs.listSync(clawsDir, { includeDirs: true });
      return entries.filter(e => e.isDirectory).map(e => e.name);
    },
    resolve(clawId) {
      return { kind: 'local', clawDir: path.join(clawsDir, clawId) };
    },
    async read() { return ''; },
    async readJSON() { return {} as any; },
  };
}

function createMockAudit(): { audit: AuditLog; events: string[][] } {
  const events: string[][] = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols.map(c => String(c))]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  } as unknown as AuditLog;
  return { audit, events };
}

describe('phase 946 contract-observer watermark + async notify', () => {
  it('watermark: archivedAt < lastArchivedAt → 不再 emit', async () => {
    const pastTs = '2026-06-04T06:35:59.482Z';
    const pastMs = new Date(pastTs).getTime();
    const olderTs = '2026-06-04T06:35:58.482Z';
    const { fs } = createMockFs({
      initialState: {
        version: 3,
        lastCheckTs: 0,
        lastArchivedAt: pastMs,
        bootstrapDone: true,
      },
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: olderTs,
      }],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: TEST_CLAWS_DIR,
      clawTopology: makeMockTopology(fs, TEST_CLAWS_DIR),
      motionDir: TEST_MOTION_DIR,
      fs,
      motionAudit: audit,
      notifyMotion: notifyClaw,
    });

    expect(notifyClaw).not.toHaveBeenCalled();
  });

  it('watermark: archivedAt > lastArchivedAt → emit', async () => {
    const futureTs = '2099-06-04T06:35:59.482Z';
    const futureMs = new Date(futureTs).getTime();
    const { fs } = createMockFs({
      initialState: {
        version: 3,
        lastCheckTs: 0,
        lastArchivedAt: 0,
        bootstrapDone: true,
      },
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: futureTs,
      }],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: TEST_CLAWS_DIR,
      clawTopology: makeMockTopology(fs, TEST_CLAWS_DIR),
      motionDir: TEST_MOTION_DIR,
      fs,
      motionAudit: audit,
      notifyMotion: notifyClaw,
    });

    expect(notifyClaw).toHaveBeenCalledTimes(1);
    const payload = notifyClaw.mock.calls[0][0] as { body: string };
    expect(payload.body).toContain('[contract_completed]');
    expect(payload.body).toContain('claw=worker-a');
    expect(payload.body).toContain('contract-1');
  });

  it('bootstrap: v1 schema migrate → 首 tick 不 emit、更新 lastArchivedAt', async () => {
    const pastTs = '2026-06-04T06:35:59.482Z';
    const pastMs = new Date(pastTs).getTime();
    const { fs, writes } = createMockFs({
      initialState: { lastCheckTs: pastMs },  // v1 schema (无 version + lastArchivedAt + bootstrapDone)
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: pastTs,
      }],
    });
    const { audit, events } = createMockAudit();
    const notifyClaw = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: TEST_CLAWS_DIR,
      clawTopology: makeMockTopology(fs, TEST_CLAWS_DIR),
      motionDir: TEST_MOTION_DIR,
      fs,
      motionAudit: audit,
      notifyMotion: notifyClaw,
    });

    // bootstrap = no emit
    expect(notifyClaw).not.toHaveBeenCalled();

    // verify state migrated to v6 + bootstrapDone + per-claw 复合游标水位更新
    const stateContent = writes.get('/test/root/motion/status/contract-observer-state.json');
    expect(stateContent).toBeDefined();
    const newState = JSON.parse(stateContent!) as {
      version: number;
      lastCheckTs: number;
      clawWatermarks: Record<string, { archivedAt: number; lastContractId: string }>;
      bootstrapDone: boolean;
    };
    expect(newState.version).toBe(6);
    expect(newState.bootstrapDone).toBe(true);
    expect(newState.clawWatermarks['worker-a']).toEqual({ archivedAt: pastMs, lastContractId: 'contract-1' });

    // bootstrap done trace audit
    const bootstrapAudits = events.filter(e => e[0] === 'contract_observer_bootstrap_done');
    expect(bootstrapAudits).toHaveLength(1);
  });

  it('bootstrap: v2 schema migrate → 首 tick 不 emit、lastArchivedAt 继承 lastCheckTs', async () => {
    const pastTs = '2026-06-04T06:35:59.482Z';
    const pastMs = new Date(pastTs).getTime();
    const { fs, writes } = createMockFs({
      initialState: {
        version: 2,
        lastCheckTs: pastMs,
        notifiedContracts: [],
        bootstrapDone: true,
      },
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: pastTs,
      }],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: TEST_CLAWS_DIR,
      clawTopology: makeMockTopology(fs, TEST_CLAWS_DIR),
      motionDir: TEST_MOTION_DIR,
      fs,
      motionAudit: audit,
      notifyMotion: notifyClaw,
    });

    expect(notifyClaw).not.toHaveBeenCalled();
    const stateContent = writes.get('/test/root/motion/status/contract-observer-state.json');
    expect(stateContent).toBeDefined();
    const newState = JSON.parse(stateContent!) as {
      version: number;
      clawWatermarks: Record<string, { archivedAt: number; lastContractId: string }>;
      bootstrapDone: boolean;
    };
    expect(newState.version).toBe(6);
    expect(newState.bootstrapDone).toBe(true);
    expect(newState.clawWatermarks['worker-a']).toEqual({ archivedAt: pastMs, lastContractId: 'contract-1' });
  });

  it('first-run (state 不存在): bootstrap path、首 tick 不 emit、更新水位', async () => {
    const pastTs = '2026-06-04T06:35:59.482Z';
    const pastMs = new Date(pastTs).getTime();
    const { fs, writes } = createMockFs({
      initialState: undefined,  // no state file
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: pastTs,
      }],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: TEST_CLAWS_DIR,
      clawTopology: makeMockTopology(fs, TEST_CLAWS_DIR),
      motionDir: TEST_MOTION_DIR,
      fs,
      motionAudit: audit,
      notifyMotion: notifyClaw,
    });

    expect(notifyClaw).not.toHaveBeenCalled();
    const stateContent = writes.get('/test/root/motion/status/contract-observer-state.json');
    expect(stateContent).toBeDefined();
    const newState = JSON.parse(stateContent!) as {
      version: number;
      bootstrapDone: boolean;
      clawWatermarks: Record<string, { archivedAt: number; lastContractId: string }>;
    };
    expect(newState.version).toBe(6);
    expect(newState.bootstrapDone).toBe(true);
    expect(newState.clawWatermarks['worker-a']).toEqual({ archivedAt: pastMs, lastContractId: 'contract-1' });
  });

  it('lastCheckTs 写 tickStart 不是 end-of-scan now', async () => {
    const beforeTick = Date.now();
    const { fs, writes } = createMockFs({
      initialState: {
        version: 3,
        lastCheckTs: 0,
        lastArchivedAt: 0,
        bootstrapDone: true,
      },
      archives: [],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: TEST_CLAWS_DIR,
      clawTopology: makeMockTopology(fs, TEST_CLAWS_DIR),
      motionDir: TEST_MOTION_DIR,
      fs,
      motionAudit: audit,
      notifyMotion: notifyClaw,
    });

    const afterTick = Date.now();
    const stateContent = writes.get('/test/root/motion/status/contract-observer-state.json');
    const newState = JSON.parse(stateContent!) as { lastCheckTs: number };
    // tickStart 在调用 runContractObserver 内最早抓、应介于 [beforeTick, afterTick]
    expect(newState.lastCheckTs).toBeGreaterThanOrEqual(beforeTick);
    expect(newState.lastCheckTs).toBeLessThanOrEqual(afterTick);
  });

  it('notifyMotion throw → state 不更新', async () => {
    const futureTs = '2099-06-04T06:35:59.482Z';
    const { fs, writes } = createMockFs({
      initialState: {
        version: 3,
        lastCheckTs: 0,
        lastArchivedAt: 0,
        bootstrapDone: true,
      },
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: futureTs,
      }],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn().mockRejectedValue(new Error('ENOSPC'));

    await expect(runContractObserver({
      clawsDir: TEST_CLAWS_DIR,
      clawTopology: makeMockTopology(fs, TEST_CLAWS_DIR),
      motionDir: TEST_MOTION_DIR,
      fs,
      motionAudit: audit,
      notifyMotion: notifyClaw,
    })).rejects.toThrow('ENOSPC');

    expect(writes.size).toBe(0);
  });
});
