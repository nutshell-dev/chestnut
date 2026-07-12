import { describe, it, expect, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import * as path from 'path';

interface ContractObserverInitialStateV3 {
  version: 3;
  lastCheckTs: number;
  lastArchivedAt: number;
  bootstrapDone: boolean;
}

interface ContractObserverInitialStateV4 {
  version: 4;
  lastCheckTs: number;
  clawWatermarks: Record<string, number>;
  bootstrapDone: boolean;
  completedNotified?: boolean;
  cancelledNotified?: boolean;
  crashedNotified?: boolean;
}

type ContractObserverInitialState = ContractObserverInitialStateV3 | ContractObserverInitialStateV4;

function makeFsMock(
  scenario: 'empty' | 'completed' | 'mixed' | 'recovery' | 'old_and_new',
  writes?: Map<string, string>,
  initialState?: ContractObserverInitialState,
): FileSystem {
  const now = Date.now();
  const oldTs = now - 86400000;
  const files = new Map<string, string>();

  // phase 948: pre-seed observer state with bootstrapDone=true、空 per-claw 水位 避免 bootstrap path 抑制首 tick emit
  files.set('/tmp/test/motion/status/contract-observer-state.json', JSON.stringify(
    initialState ?? {
      version: 4,
      lastCheckTs: 0,
      clawWatermarks: {},
      bootstrapDone: true,
      completedNotified: false,
      cancelledNotified: false,
      crashedNotified: false,
    }
  ));

  if (scenario === 'completed') {
    files.set('/tmp/test/claws/claw1/contract/archive/contract-a/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'contract-a',
      status: 'completed',
      subtasks: {
        st1: { completed_at: new Date(now).toISOString() },
      },
    }));
  }

  if (scenario === 'mixed') {
    files.set('/tmp/test/claws/claw1/contract/archive/c1/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'c1',
      status: 'completed',
      subtasks: { st1: { completed_at: new Date(now).toISOString() } },
    }));
    files.set('/tmp/test/claws/claw1/contract/archive/c2/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'c2',
      status: 'cancelled',
      checkpoint: 'cancelled: user manual',
      subtasks: { st1: { completed_at: new Date(now).toISOString() } },
    }));
    files.set('/tmp/test/claws/claw1/contract/archive/c3/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'c3',
      status: 'crashed',
      checkpoint: 'crashed: system: maxstepsexceedederror',
      subtasks: { st1: { completed_at: new Date(now).toISOString() } },
    }));
  }

  if (scenario === 'recovery') {
    files.set('/tmp/test/claws/claw1/contract/archive/c-recovery/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'c-recovery',
      status: 'archive_pending_recovery',
      subtasks: { st1: { completed_at: new Date(now).toISOString() } },
    }));
  }

  if (scenario === 'old_and_new') {
    files.set('/tmp/test/claws/claw1/contract/archive/old-contract/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'old-contract',
      status: 'completed',
      subtasks: { st1: { completed_at: new Date(oldTs).toISOString() } },
    }));
    files.set('/tmp/test/claws/claw1/contract/archive/new-contract/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'new-contract',
      status: 'completed',
      subtasks: { st1: { completed_at: new Date(now).toISOString() } },
    }));
  }

  const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();
  if (scenario === 'completed') {
    dirs.set('/tmp/test/claws', [{ name: 'claw1', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1', [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract', [{ name: 'archive', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract/archive', [{ name: 'contract-a', isDirectory: true, size: 0 }]);
  } else if (scenario === 'mixed') {
    dirs.set('/tmp/test/claws', [{ name: 'claw1', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1', [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract', [{ name: 'archive', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract/archive', [
      { name: 'c1', isDirectory: true, size: 0 },
      { name: 'c2', isDirectory: true, size: 0 },
      { name: 'c3', isDirectory: true, size: 0 },
    ]);
  } else if (scenario === 'recovery') {
    dirs.set('/tmp/test/claws', [{ name: 'claw1', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1', [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract', [{ name: 'archive', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract/archive', [
      { name: 'c-recovery', isDirectory: true, size: 0 },
    ]);
  } else if (scenario === 'old_and_new') {
    dirs.set('/tmp/test/claws', [{ name: 'claw1', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1', [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract', [{ name: 'archive', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract/archive', [
      { name: 'old-contract', isDirectory: true, size: 0 },
      { name: 'new-contract', isDirectory: true, size: 0 },
    ]);
  } else {
    dirs.set('/tmp/test/claws', [{ name: 'claw1', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1', [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract', [{ name: 'archive', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract/archive', []);
  }

  return {
    existsSync: (p: string) => dirs.has(p) || files.has(p),
    listSync: (p: string) => dirs.get(p) ?? [],
    readSync: (p: string) => {
      if (files.has(p)) return files.get(p)!;
      throw new Error('ENOENT');
    },
    ensureDirSync: () => {},
    writeAtomicSync: (p: string, content: string) => writes?.set(p, content),
  } as unknown as FileSystem;
}

function makeAuditMock(): AuditLog {
  return makeMockAudit();
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

function makeOpts(overrides: Partial<{
  fs: FileSystem;
  motionAudit: AuditLog;
  notifyMotion: ReturnType<typeof vi.fn>;
}> = {}) {
  const fs = overrides.fs ?? makeFsMock('empty');
  return {
    clawsDir: '/tmp/test/claws',
    clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
    motionDir: '/tmp/test/motion',
    fs,
    motionAudit: overrides.motionAudit ?? makeAuditMock(),
    notifyMotion: overrides.notifyMotion ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe('Phase 542 — contract-observer deps 装配方注入', () => {
  it('completed contract events → notifyMotion called', async () => {
    const opts = makeOpts({ fs: makeFsMock('completed') });
    await runContractObserver(opts);
    expect(opts.notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_events' }),
    );
  });

  it('no events → notifyMotion NOT called', async () => {
    const opts = makeOpts({ fs: makeFsMock('empty') });
    await runContractObserver(opts);
    expect(opts.notifyMotion).not.toHaveBeenCalled();
  });

  it('phase 63: 分流 3 个 notifyMotion 调用 by status', async () => {
    const opts = makeOpts({ fs: makeFsMock('mixed') });
    await runContractObserver(opts);

    expect(opts.notifyMotion).toHaveBeenCalledTimes(3);
    expect(opts.notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_events', body: expect.stringContaining('c1') }),
    );
    expect(opts.notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'contract_cancelled',
        body: expect.stringContaining('c2'),
        extraFields: expect.objectContaining({
          cancellations: expect.stringContaining('c2'),
        }),
      }),
    );
    expect(opts.notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'contract_crashed',
        body: expect.stringContaining('c3'),
        extraFields: expect.objectContaining({
          crashes: expect.stringContaining('c3'),
        }),
      }),
    );
  });

  it('phase 197: archive_pending_recovery 不投 motion、emit audit', async () => {
    const opts = makeOpts({ fs: makeFsMock('recovery') });
    await runContractObserver(opts);

    // 不投 motion inbox
    expect(opts.notifyMotion).not.toHaveBeenCalled();

    // emit audit
    expect(opts.motionAudit.write).toHaveBeenCalledWith(
      'contract_archive_recovery_pending_observed',
      'clawId=claw1',
      'contractId=c-recovery',
      'context=observer_scan',
    );
  });
});

describe('Phase 946 — contract-observer 三项根治修复', () => {
  it('does not re-notify contracts archived before lastArchivedAt', async () => {
    const notifyMotion = vi.fn().mockResolvedValue(undefined);
    const fs = makeFsMock('old_and_new', undefined, {
      version: 3,
      lastCheckTs: 0,
      // old-contract archivedAt = Date.now() - 86400000，设 lastArchivedAt 为 oldTs 使其被跳过
      lastArchivedAt: Date.now() - 86400000,
      bootstrapDone: true,
    });

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: makeAuditMock(),
      notifyMotion,
    });

    expect(notifyMotion).toHaveBeenCalledTimes(1);
    expect(notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_events', body: expect.stringContaining('new-contract') }),
    );
  });

  it('does not update state when notifyMotion throws', async () => {
    const writes = new Map<string, string>();
    const fs = makeFsMock('completed', writes);
    const notifyMotion = vi.fn().mockRejectedValue(new Error('ENOSPC'));

    await expect(runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: makeAuditMock(),
      notifyMotion,
    })).rejects.toThrow('ENOSPC');

    // state file 应未被写入（makeFsMock 只在 writeAtomicSync 时写 writes map）
    expect(writes.size).toBe(0);
  });

  it('throws when state file is corrupted', async () => {
    const fs = makeFsMock('empty');
    vi.spyOn(fs, 'readSync').mockImplementation(() => {
      throw new Error('EIO');
    });
    const audit = makeAuditMock();

    await expect(runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: audit,
      notifyMotion: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Observer state corrupt');
  });
});

// phase 948: 多 claw / 部分失败场景辅助函数
interface ContractSpec {
  contractId: string;
  status: 'completed' | 'cancelled' | 'crashed';
  archivedAt: number;
  checkpoint?: string;
}

function makeMultiClawFsMock(
  claws: Record<string, { scanFails?: boolean; contracts: ContractSpec[] }>,
  writes: Map<string, string>,
  initialState?: ContractObserverInitialStateV4,
): FileSystem {
  const files = new Map<string, string>();
  const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();

  files.set('/tmp/test/motion/status/contract-observer-state.json', JSON.stringify(
    initialState ?? {
      version: 4,
      lastCheckTs: 0,
      clawWatermarks: {},
      bootstrapDone: true,
      completedNotified: false,
      cancelledNotified: false,
      crashedNotified: false,
    }
  ));

  dirs.set('/tmp/test/claws', Object.keys(claws).map(name => ({ name, isDirectory: true, size: 0 })));

  for (const [clawId, { contracts, scanFails }] of Object.entries(claws)) {
    const clawDir = `/tmp/test/claws/${clawId}`;
    dirs.set(clawDir, [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set(`${clawDir}/contract`, [{ name: 'archive', isDirectory: true, size: 0 }]);
    const archiveDir = `${clawDir}/contract/archive`;
    dirs.set(archiveDir, contracts.map(c => ({ name: c.contractId, isDirectory: true, size: 0 })));

    for (const c of contracts) {
      const contractDir = `${archiveDir}/${c.contractId}`;
      const progress: Record<string, unknown> = {
        schema_version: 1,
        contract_id: c.contractId,
        status: c.status,
        subtasks: {
          st1: { completed_at: new Date(c.archivedAt).toISOString() },
        },
      };
      if (c.checkpoint) progress.checkpoint = c.checkpoint;
      files.set(`${contractDir}/progress.json`, JSON.stringify(progress));
    }
  }

  return {
    existsSync: (p: string) => dirs.has(p) || files.has(p),
    listSync: (p: string, _opts?: unknown) => {
      if (p.endsWith('/contract/archive')) {
        const match = p.match(/\/claws\/([^/]+)\/contract\/archive$/);
        const clawId = match?.[1];
        if (clawId && claws[clawId]?.scanFails) {
          const err = new Error('EIO') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
      }
      return dirs.get(p) ?? [];
    },
    readSync: (p: string) => {
      if (files.has(p)) return files.get(p)!;
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
    ensureDirSync: () => {},
    writeAtomicSync: (p: string, content: string) => writes.set(p, content),
  } as unknown as FileSystem;
}

function parseState(writes: Map<string, string>): ContractObserverInitialStateV4 | undefined {
  const raw = writes.get('/tmp/test/motion/status/contract-observer-state.json');
  if (!raw) return undefined;
  return JSON.parse(raw) as ContractObserverInitialStateV4;
}

describe('Phase 948 — contract-observer per-claw watermark + compound cursor + idempotent delivery', () => {
  it('does not advance watermark for a failed claw scan', async () => {
    const writes1 = new Map<string, string>();
    const fs1 = makeMultiClawFsMock(
      {
        clawA: { scanFails: true, contracts: [] },
        clawB: { contracts: [{ contractId: 'b1', status: 'completed', archivedAt: 100 }] },
      },
      writes1,
    );
    const notifyMotion1 = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs1, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs: fs1,
      motionAudit: makeAuditMock(),
      notifyMotion: notifyMotion1,
    });

    expect(notifyMotion1).toHaveBeenCalledTimes(1);
    expect(notifyMotion1).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_events', body: expect.stringContaining('b1') }),
    );

    const state1 = parseState(writes1);
    expect(state1?.clawWatermarks.clawA).toBeUndefined();
    expect(state1?.clawWatermarks.clawB).toBe(100);

    // 第二次运行：clawA 扫描恢复，其事件应被处理；clawB 水位已推进，不重复通知
    const writes2 = new Map<string, string>();
    const fs2 = makeMultiClawFsMock(
      {
        clawA: { contracts: [{ contractId: 'a1', status: 'completed', archivedAt: 50 }] },
        clawB: { contracts: [{ contractId: 'b1', status: 'completed', archivedAt: 100 }] },
      },
      writes2,
      state1,
    );
    const notifyMotion2 = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs2, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs: fs2,
      motionAudit: makeAuditMock(),
      notifyMotion: notifyMotion2,
    });

    expect(notifyMotion2).toHaveBeenCalledTimes(1);
    expect(notifyMotion2).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_events', body: expect.stringContaining('a1') }),
    );
    expect(notifyMotion2).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_events', body: expect.stringContaining('b1') }),
    );
  });

  it('processes multiple contracts at the same archivedAt without overlap', async () => {
    const writes1 = new Map<string, string>();
    const fs1 = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [
            { contractId: 'c1', status: 'completed', archivedAt: 100 },
            { contractId: 'c2', status: 'completed', archivedAt: 100 },
          ],
        },
      },
      writes1,
    );
    const notifyMotion1 = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs1, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs: fs1,
      motionAudit: makeAuditMock(),
      notifyMotion: notifyMotion1,
    });

    expect(notifyMotion1).toHaveBeenCalledTimes(1);
    const body = notifyMotion1.mock.calls[0][0] as { body: string };
    expect(body.body).toContain('c1');
    expect(body.body).toContain('c2');

    const state1 = parseState(writes1);
    expect(state1?.clawWatermarks.clawA).toBe(100);

    // 第二次运行：同时间戳契约不再重复通知
    const writes2 = new Map<string, string>();
    const fs2 = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [
            { contractId: 'c1', status: 'completed', archivedAt: 100 },
            { contractId: 'c2', status: 'completed', archivedAt: 100 },
          ],
        },
      },
      writes2,
      state1,
    );
    const notifyMotion2 = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs2, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs: fs2,
      motionAudit: makeAuditMock(),
      notifyMotion: notifyMotion2,
    });

    expect(notifyMotion2).not.toHaveBeenCalled();
  });

  it('does not re-deliver completed events when cancelled fails', async () => {
    const writes1 = new Map<string, string>();
    const fs1 = makeMultiClawFsMock(
      {
        clawCompleted: {
          contracts: [{ contractId: 'completed-1', status: 'completed', archivedAt: 100 }],
        },
        clawCancelled: {
          contracts: [{ contractId: 'cancelled-1', status: 'cancelled', archivedAt: 100, checkpoint: 'cancelled: user manual' }],
        },
      },
      writes1,
    );
    const notifyMotion1 = vi.fn()
      .mockResolvedValueOnce(undefined) // completed succeeds
      .mockRejectedValueOnce(new Error('ENOSPC')); // cancelled fails

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs1, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs: fs1,
      motionAudit: makeAuditMock(),
      notifyMotion: notifyMotion1,
    });

    expect(notifyMotion1).toHaveBeenCalledTimes(2);

    const state1 = parseState(writes1);
    expect(state1?.completedNotified).toBe(true);
    expect(state1?.cancelledNotified).toBe(false);
    // 部分失败时水位不推进
    expect(state1?.clawWatermarks.clawCompleted).toBeUndefined();
    expect(state1?.clawWatermarks.clawCancelled).toBeUndefined();

    // 第二次运行：completed 已被标记为已通知，只重试 cancelled
    const writes2 = new Map<string, string>();
    const fs2 = makeMultiClawFsMock(
      {
        clawCompleted: {
          contracts: [{ contractId: 'completed-1', status: 'completed', archivedAt: 100 }],
        },
        clawCancelled: {
          contracts: [{ contractId: 'cancelled-1', status: 'cancelled', archivedAt: 100, checkpoint: 'cancelled: user manual' }],
        },
      },
      writes2,
      state1,
    );
    const notifyMotion2 = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs2, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs: fs2,
      motionAudit: makeAuditMock(),
      notifyMotion: notifyMotion2,
    });

    expect(notifyMotion2).toHaveBeenCalledTimes(1);
    expect(notifyMotion2).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_cancelled', body: expect.stringContaining('cancelled-1') }),
    );
    expect(notifyMotion2).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_events', body: expect.stringContaining('completed-1') }),
    );

    // 全部成功后 batch 结束：水位推进、投递标记复位
    const state2 = parseState(writes2);
    expect(state2?.completedNotified).toBe(false);
    expect(state2?.cancelledNotified).toBe(false);
    expect(state2?.clawWatermarks.clawCompleted).toBe(100);
    expect(state2?.clawWatermarks.clawCancelled).toBe(100);
  });
});
