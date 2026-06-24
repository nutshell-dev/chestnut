/**
 * phase 37: contract-observer race 根治 单测
 *
 * 三 case 覆盖：
 * - race fix: subtask.completed_at < lastCheckTs 但未在 notifiedSet 仍 emit（治本验证）
 * - dedup: 已在 notifiedSet 不再 emit（dedup 验证）
 * - bootstrap: v1 schema → v2 migration、首 tick 填 set 不 emit
 *
 * mock fs in-memory、不依赖 real time。
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
  status: 'completed' | 'running';
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

describe('phase 37 contract-observer race 根治', () => {
  it('race fix: contract.completed_at < lastCheckTs 但未在 notifiedSet → 仍 emit', async () => {
    // 模拟 gateway-auditor 14:35:59.482 race case：
    //   subtask.completed_at = 1780554959482ms (14:35:59.482Z)
    //   lastCheckTs = 1780554959500ms (14:35:59.500Z) → > completed_at (race window 内)
    //   notifiedContracts = [] (此 contract 未被通知过)
    // 旧 buggy 实现：completed_at < lastCheckTs → 跳 → motion 漏 emit
    // 新 dedup-based：notifiedSet 不含此 key → emit ✓
    const { fs } = createMockFs({
      initialState: {
        version: 2,
        lastCheckTs: 1780554959500,
        notifiedContracts: [],
        bootstrapDone: true,
      },
      archives: [{
        clawId: 'gateway-auditor',
        contractId: '1780554681078-ee7dbf4d',
        status: 'completed',
        subtaskCompletedAt: '2026-06-04T06:35:59.482Z',
      }],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn();

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
    expect(payload.body).toContain('claw=gateway-auditor');
    expect(payload.body).toContain('1780554681078-ee7dbf4d');
  });

  it('dedup: contract 已在 notifiedSet → 不再 emit', async () => {
    const { fs } = createMockFs({
      initialState: {
        version: 2,
        lastCheckTs: 0,
        notifiedContracts: ['worker-a:contract-1'],
        bootstrapDone: true,
      },
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: '2026-06-04T06:35:59.482Z',
      }],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn();

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

  it('bootstrap: v1 schema migrate → 首 tick 仅填 set 不 emit', async () => {
    const { fs, writes } = createMockFs({
      initialState: { lastCheckTs: 1780555000000 },  // v1 schema (无 version + notifiedContracts + bootstrapDone)
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: '2026-06-04T06:35:59.482Z',
      }],
    });
    const { audit, events } = createMockAudit();
    const notifyClaw = vi.fn();

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

    // verify state migrated to v2 + bootstrapDone + notifiedContracts 填齐
    const stateContent = writes.get('/test/root/motion/status/contract-observer-state.json');
    expect(stateContent).toBeDefined();
    const newState = JSON.parse(stateContent!) as {
      version: number;
      lastCheckTs: number;
      notifiedContracts: string[];
      bootstrapDone: boolean;
    };
    expect(newState.version).toBe(2);
    expect(newState.bootstrapDone).toBe(true);
    expect(newState.notifiedContracts).toContain('worker-a:contract-1');

    // bootstrap done trace audit
    const bootstrapAudits = events.filter(e => e[0] === 'contract_observer_bootstrap_done');
    expect(bootstrapAudits).toHaveLength(1);
  });

  it('first-run (state 不存在): bootstrap path、首 tick 填 set 不 emit', async () => {
    const { fs, writes } = createMockFs({
      initialState: undefined,  // no state file
      archives: [{
        clawId: 'worker-a',
        contractId: 'contract-1',
        status: 'completed',
        subtaskCompletedAt: '2026-06-04T06:35:59.482Z',
      }],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn();

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
      bootstrapDone: boolean;
      notifiedContracts: string[];
    };
    expect(newState.bootstrapDone).toBe(true);
    expect(newState.notifiedContracts).toContain('worker-a:contract-1');
  });

  it('lastCheckTs 写 tickStart 不是 end-of-scan now', async () => {
    const beforeTick = Date.now();
    const { fs, writes } = createMockFs({
      initialState: {
        version: 2,
        lastCheckTs: 0,
        notifiedContracts: [],
        bootstrapDone: true,
      },
      archives: [],
    });
    const { audit } = createMockAudit();
    const notifyClaw = vi.fn();

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
});
