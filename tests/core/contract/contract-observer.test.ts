import { describe, it, expect, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import * as path from 'path';

function makeFsMock(scenario: 'empty' | 'completed' | 'mixed' | 'recovery'): FileSystem {
  const now = Date.now();
  const oldTs = now - 86400000;
  const files = new Map<string, string>();

  // phase 37: pre-seed observer state with bootstrapDone=true、避免 bootstrap path 抑制首 tick emit
  files.set('/tmp/test/motion/status/contract-observer-state.json', JSON.stringify({
    version: 2,
    lastCheckTs: 0,
    notifiedContracts: [],
    bootstrapDone: true,
  }));

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
      subtasks: {},
    }));
    files.set('/tmp/test/claws/claw1/contract/archive/c3/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'c3',
      status: 'crashed',
      checkpoint: 'crashed: system: maxstepsexceedederror',
      subtasks: {},
    }));
  }

  if (scenario === 'recovery') {
    files.set('/tmp/test/claws/claw1/contract/archive/c-recovery/progress.json', JSON.stringify({ schema_version: 1,
      contract_id: 'c-recovery',
      status: 'archive_pending_recovery',
      subtasks: {},
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
    writeAtomicSync: () => {},
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
    notifyMotion: overrides.notifyMotion ?? vi.fn(),
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
