import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import * as eventCollector from '../../../src/core/contract/jobs/event-collector.js';
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

interface ClawWatermarkCursor {
  archivedAt: number;
  lastContractId: string;
}

interface ContractObserverInitialStateV5 {
  version: 5;
  lastCheckTs: number;
  clawWatermarks: Record<string, ClawWatermarkCursor>;
  bootstrapDone: boolean;
  completedWatermarks?: Record<string, ClawWatermarkCursor>;
  cancelledWatermarks?: Record<string, ClawWatermarkCursor>;
  crashedWatermarks?: Record<string, ClawWatermarkCursor>;
}

type ContractObserverInitialState = ContractObserverInitialStateV3 | ContractObserverInitialStateV5;

function makeFsMock(
  scenario: 'empty' | 'completed' | 'completed_with_failure' | 'mixed' | 'recovery' | 'old_and_new',
  writes?: Map<string, string>,
  initialState?: ContractObserverInitialState,
): FileSystem {
  const now = Date.now();
  const oldTs = now - 86400000;
  const files = new Map<string, string>();

  // phase 948: pre-seed observer state with bootstrapDone=true、空 per-claw 水位 避免 bootstrap path 抑制首 tick emit
  files.set('/tmp/test/motion/status/contract-observer-state.json', JSON.stringify(
    initialState ?? {
      version: 5,
      lastCheckTs: 0,
      clawWatermarks: {},
      bootstrapDone: true,
      completedWatermarks: {},
      cancelledWatermarks: {},
      crashedWatermarks: {},
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

  if (scenario === 'completed_with_failure') {
    files.set('/tmp/test/claws/claw1/contract/archive/contract-f/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'contract-f',
      status: 'completed',
      subtasks: {
        st1: {
          status: 'completed',
          completed_at: new Date(now).toISOString(),
          last_failed_feedback: { feedback: 'flaky suite' },
        },
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
  } else if (scenario === 'completed_with_failure') {
    dirs.set('/tmp/test/claws', [{ name: 'claw1', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1', [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract', [{ name: 'archive', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract/archive', [{ name: 'contract-f', isDirectory: true, size: 0 }]);
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

  it('phase 1261 Step B: completed 无失败契约 → v1 空 refs wire（正文仍投递、watermark 推进）', async () => {
    const writes = new Map<string, string>();
    const opts = makeOpts({ fs: makeFsMock('completed', writes) });
    await runContractObserver(opts);

    // 精确 v1 wire：guidance_schema_version + contract_refs=[]，无 legacy problem_pairs
    expect(opts.notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'contract_events',
        extraFields: {
          guidance_schema_version: '1',
          contract_refs: '[]',
        },
      }),
    );
    const state = parseState(writes);
    expect(state?.completedWatermarks.claw1).toBeDefined();
  });

  it('phase 1261 Step B: completed 有失败契约 → v1 batch refs wire（typed refs 经 owner encoder）', async () => {
    const opts = makeOpts({ fs: makeFsMock('completed_with_failure') });
    await runContractObserver(opts);

    expect(opts.notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'contract_events',
        body: expect.stringContaining('contract-f'),
        extraFields: {
          guidance_schema_version: '1',
          contract_refs: '[{"claw_id":"claw1","contract_id":"contract-f"}]',
        },
      }),
    );
  });

  it('no events → notifyMotion NOT called', async () => {
    const opts = makeOpts({ fs: makeFsMock('empty') });
    await runContractObserver(opts);
    expect(opts.notifyMotion).not.toHaveBeenCalled();
  });

  it('phase 1121 Step D: completed/cancelled 投 motion、legacy crashed 只走 audit', async () => {
    const opts = makeOpts({ fs: makeFsMock('mixed') });
    await runContractObserver(opts);

    expect(opts.notifyMotion).toHaveBeenCalledTimes(2);
    expect(opts.notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_events', body: expect.stringContaining('c1') }),
    );
    expect(opts.notifyMotion).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'contract_cancelled',
        body: expect.stringContaining('c2'),
        // phase 1262 Step B: v1 exact wire（typed refs 经 owner encoder），不再手写 cancellations JSON
        extraFields: {
          guidance_schema_version: '1',
          cancelled_contract_refs: '[{"claw_id":"claw1","contract_id":"c2"}]',
        },
      }),
    );
    expect(opts.notifyMotion).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contract_crashed' }),
    );

    // phase 1121 Step D: historical status=crashed 生成 legacy audit、不投 motion
    expect(opts.motionAudit.write).toHaveBeenCalledWith(
      'contract_legacy_crashed_observed',
      'clawId=claw1',
      'contractId=c3',
      expect.stringContaining('source_path='),
      'status=legacy_crashed',
    );
  });

  it('Step F: legacy archive_pending_recovery is skipped silently (no motion, no observer audit)', async () => {
    const opts = makeOpts({ fs: makeFsMock('recovery') });
    await runContractObserver(opts);

    // 不投 motion inbox
    expect(opts.notifyMotion).not.toHaveBeenCalled();

    // No current-lifecycle audit is emitted for this dead state.
    expect(opts.motionAudit.write).not.toHaveBeenCalledWith(
      'contract_archive_recovery_pending_observed',
      expect.anything(),
      expect.anything(),
      expect.anything(),
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
  initialState?: ContractObserverInitialStateV5,
): FileSystem {
  const files = new Map<string, string>();
  const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();

  files.set('/tmp/test/motion/status/contract-observer-state.json', JSON.stringify(
    initialState ?? {
      version: 5,
      lastCheckTs: 0,
      clawWatermarks: {},
      bootstrapDone: true,
      completedWatermarks: {},
      cancelledWatermarks: {},
      crashedWatermarks: {},
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

function parseState(writes: Map<string, string>): ContractObserverInitialStateV5 | undefined {
  const raw = writes.get('/tmp/test/motion/status/contract-observer-state.json');
  if (!raw) return undefined;
  return JSON.parse(raw) as ContractObserverInitialStateV5;
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
    expect(state1?.clawWatermarks.clawB).toEqual({ archivedAt: 100, lastContractId: 'b1' });

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
    expect(state1?.clawWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'c2' });

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
    expect(state1?.completedWatermarks.clawCompleted).toEqual({ archivedAt: 100, lastContractId: 'completed-1' });
    expect(state1?.cancelledWatermarks.clawCancelled).toBeUndefined();
    // Phase 1396 Step M: 总水位按“该 claw 的 entry 是否被其全部消费者越过”推进 ——
    // clawCompleted 的 completed entry 已成功通知（本测试无 retro 消费者），水位推进；
    // clawCancelled 的 cancelled 通知失败，水位不推进。
    expect(state1?.clawWatermarks.clawCompleted).toEqual({ archivedAt: 100, lastContractId: 'completed-1' });
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

    // 全部成功后 batch 结束：per-claw 复合游标推进、per-claw per-status watermark 推进
    const state2 = parseState(writes2);
    expect(state2?.completedWatermarks.clawCompleted).toEqual({ archivedAt: 100, lastContractId: 'completed-1' });
    expect(state2?.cancelledWatermarks.clawCancelled).toEqual({ archivedAt: 100, lastContractId: 'cancelled-1' });
    expect(state2?.clawWatermarks.clawCompleted).toEqual({ archivedAt: 100, lastContractId: 'completed-1' });
    expect(state2?.clawWatermarks.clawCancelled).toEqual({ archivedAt: 100, lastContractId: 'cancelled-1' });
  });
});

describe('Phase 1396 Step M — observer retrospective 水位（独立于 Motion 通知）', () => {
  function makeRunOpts(fs: FileSystem, writes: Map<string, string>, extra?: {
    notifyMotion?: ReturnType<typeof vi.fn>;
    onCompletedContract?: (clawId: string, contractId: string) => Promise<void>;
  }) {
    return {
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: makeAuditMock(),
      notifyMotion: extra?.notifyMotion ?? vi.fn().mockResolvedValue(undefined),
      onCompletedContract: extra?.onCompletedContract,
    };
  }

  it('retro 成功 → retrospectiveWatermarks 与总水位同步推进', async () => {
    const writes = new Map<string, string>();
    const fs = makeMultiClawFsMock(
      { clawA: { contracts: [{ contractId: 'c1', status: 'completed', archivedAt: 100 }] } },
      writes,
    );
    const onCompletedContract = vi.fn().mockResolvedValue(undefined);

    await runContractObserver(makeRunOpts(fs, writes, { onCompletedContract }));

    expect(onCompletedContract).toHaveBeenCalledWith('clawA', 'c1');
    const state = parseState(writes) as any;
    expect(state?.retrospectiveWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'c1' });
    expect(state?.clawWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'c1' });
  });

  it('retro 失败 → retro 水位与总水位停在失败 entry 前，通知水位独立推进；下一 tick 只重试 retro', async () => {
    const writes1 = new Map<string, string>();
    const fs1 = makeMultiClawFsMock(
      { clawA: { contracts: [{ contractId: 'c1', status: 'completed', archivedAt: 100 }] } },
      writes1,
    );
    const notifyMotion1 = vi.fn().mockResolvedValue(undefined);
    const onCompletedContract1 = vi.fn().mockRejectedValue(new Error('evolution down'));

    await runContractObserver(makeRunOpts(fs1, writes1, { notifyMotion: notifyMotion1, onCompletedContract: onCompletedContract1 }));

    const state1 = parseState(writes1) as any;
    // 通知成功 → completedWatermarks 推进；retro 失败 → retro 水位不推进、总水位不越过 c1
    expect(state1?.completedWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'c1' });
    expect(state1?.retrospectiveWatermarks.clawA).toBeUndefined();
    expect(state1?.clawWatermarks.clawA).toBeUndefined();

    // 下一 tick：通知被 completedWatermarks 跳过，retro 重试成功
    const writes2 = new Map<string, string>();
    const fs2 = makeMultiClawFsMock(
      { clawA: { contracts: [{ contractId: 'c1', status: 'completed', archivedAt: 100 }] } },
      writes2,
      state1,
    );
    const notifyMotion2 = vi.fn().mockResolvedValue(undefined);
    const onCompletedContract2 = vi.fn().mockResolvedValue(undefined);

    await runContractObserver(makeRunOpts(fs2, writes2, { notifyMotion: notifyMotion2, onCompletedContract: onCompletedContract2 }));

    expect(notifyMotion2).not.toHaveBeenCalled();
    expect(onCompletedContract2).toHaveBeenCalledWith('clawA', 'c1');
    const state2 = parseState(writes2) as any;
    expect(state2?.retrospectiveWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'c1' });
    expect(state2?.clawWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'c1' });
  });

  it('同 executor 首条 retro 失败 → 本 tick 后续 entry 不再 retro；其他 executor 不受影响', async () => {
    const writes = new Map<string, string>();
    const fs = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [
            { contractId: 'c1', status: 'completed', archivedAt: 100 },
            { contractId: 'c2', status: 'completed', archivedAt: 200 },
          ],
        },
        clawB: { contracts: [{ contractId: 'b1', status: 'completed', archivedAt: 150 }] },
      },
      writes,
    );
    const calls: Array<[string, string]> = [];
    const onCompletedContract = vi.fn(async (clawId: string, contractId: string) => {
      calls.push([clawId, contractId]);
      if (contractId === 'c1') throw new Error('boom');
    });

    await runContractObserver(makeRunOpts(fs, writes, { onCompletedContract }));

    // clawA: c1 失败后 c2 本 tick 不再 retro；clawB: b1 正常交付
    expect(calls).toEqual([['clawA', 'c1'], ['clawB', 'b1']]);
    const state = parseState(writes) as any;
    expect(state?.retrospectiveWatermarks.clawA).toBeUndefined();
    expect(state?.retrospectiveWatermarks.clawB).toEqual({ archivedAt: 150, lastContractId: 'b1' });
    // 总水位：clawA 停在失败前（不推进），clawB 推进
    expect(state?.clawWatermarks.clawA).toBeUndefined();
    expect(state?.clawWatermarks.clawB).toEqual({ archivedAt: 150, lastContractId: 'b1' });
  });

  it('v6 state 迁移 → retrospectiveWatermarks 以 clawWatermarks 初始化，不回放历史 retro', async () => {
    const v6State = {
      version: 6,
      lastCheckTs: 50,
      clawWatermarks: { clawA: { archivedAt: 100, lastContractId: 'c1' } },
      bootstrapDone: true,
      completedWatermarks: { clawA: { archivedAt: 100, lastContractId: 'c1' } },
      cancelledWatermarks: {},
      crashedWatermarks: {},
      reportedCorrupted: {},
      reportedActiveState: {},
    };
    const writes = new Map<string, string>();
    const fs = makeMultiClawFsMock(
      { clawA: { contracts: [{ contractId: 'c1', status: 'completed', archivedAt: 100 }] } },
      writes,
      v6State as any,
    );
    const onCompletedContract = vi.fn().mockResolvedValue(undefined);

    await runContractObserver(makeRunOpts(fs, writes, { onCompletedContract }));

    // v6 迁移后 retro 水位 = clawWatermarks → 历史 completed 不补发 retro
    expect(onCompletedContract).not.toHaveBeenCalled();
    const state = parseState(writes) as any;
    expect(state?.version).toBe(7);
    expect(state?.retrospectiveWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'c1' });
  });
});

describe('Phase 950 — observer composite cursor + batch watermark + collector incomplete', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processes second contract with same archivedAt in next tick', async () => {
    const writes1 = new Map<string, string>();
    const fs1 = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [{ contractId: 'contract-A', status: 'completed', archivedAt: 100 }],
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
    const state1 = parseState(writes1);
    expect(state1?.clawWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'contract-A' });

    // Tick 2: contract-A reappears (filtered) + contract-B at same archivedAt (NOT filtered)
    const writes2 = new Map<string, string>();
    const fs2 = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [
            { contractId: 'contract-A', status: 'completed', archivedAt: 100 },
            { contractId: 'contract-B', status: 'completed', archivedAt: 100 },
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

    expect(notifyMotion2).toHaveBeenCalledTimes(1);
    const body2 = notifyMotion2.mock.calls[0][0] as { body: string };
    expect(body2.body).toContain('contract-B');
    expect(body2.body).not.toContain('contract-A');

    const state2 = parseState(writes2);
    expect(state2?.clawWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'contract-B' });
  });

  it('new completed events are sent after previous batch succeeded', async () => {
    const writes1 = new Map<string, string>();
    const fs1 = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [{ contractId: 'completed-1', status: 'completed', archivedAt: 100 }],
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
    const state1 = parseState(writes1);
    expect(state1?.completedWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: 'completed-1' });

    // Tick 2: a new completed event at a later timestamp must still be sent
    const writes2 = new Map<string, string>();
    const fs2 = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [
            { contractId: 'completed-1', status: 'completed', archivedAt: 100 },
            { contractId: 'completed-2', status: 'completed', archivedAt: 200 },
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

    expect(notifyMotion2).toHaveBeenCalledTimes(1);
    const body2 = notifyMotion2.mock.calls[0][0] as { body: string };
    expect(body2.body).toContain('completed-2');
    expect(body2.body).not.toContain('completed-1');

    const state2 = parseState(writes2);
    expect(state2?.completedWatermarks.clawA).toEqual({ archivedAt: 200, lastContractId: 'completed-2' });
  });

  it('does not advance claw watermark when scan is incomplete', async () => {
    const writes1 = new Map<string, string>();
    const fs1 = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [{ contractId: 'ok-1', status: 'completed', archivedAt: 100 }],
        },
      },
      writes1,
    );

    vi.spyOn(eventCollector, 'scanArchivedContracts').mockResolvedValue({
      entries: [{ contractId: 'ok-1', body: 'ok', hasFailure: false, archivedAt: 100, status: 'completed' }],
      incomplete: true,
    });

    const notifyMotion1 = vi.fn().mockResolvedValue(undefined);
    const audit = makeAuditMock();

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs1, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs: fs1,
      motionAudit: audit,
      notifyMotion: notifyMotion1,
    });

    expect(notifyMotion1).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      'contract_observer_event_failed',
      'claw=clawA',
      'reason=scan_incomplete',
    );
    const state1 = parseState(writes1);
    expect(state1?.clawWatermarks.clawA).toBeUndefined();
  });

  it('migrates legacy number watermark to composite cursor', async () => {
    const writes = new Map<string, string>();
    const fs = makeMultiClawFsMock(
      {
        clawA: {
          contracts: [],
        },
      },
      writes,
      {
        version: 4,
        lastCheckTs: 0,
        clawWatermarks: { clawA: 100 as unknown as ClawWatermarkCursor },
        bootstrapDone: true,
        completedWatermarks: {},
        cancelledWatermarks: {},
        crashedWatermarks: {},
      },
    );
    const notifyMotion = vi.fn().mockResolvedValue(undefined);

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: makeAuditMock(),
      notifyMotion,
    });

    const state = parseState(writes);
    expect(state?.clawWatermarks.clawA).toEqual({ archivedAt: 100, lastContractId: '' });
    expect(notifyMotion).not.toHaveBeenCalled();
  });
});
