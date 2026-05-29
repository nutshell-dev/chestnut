import { describe, it, expect, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeFsMock(scenario: 'empty' | 'completed'): FileSystem {
  const now = Date.now();
  const oldTs = now - 86400000;
  const files = new Map<string, string>();

  if (scenario === 'completed') {
    files.set('/tmp/test/claws/claw1/contract/archive/contract-a/progress.json', JSON.stringify({
      contract_id: 'contract-a',
      status: 'completed',
      subtasks: {
        st1: { completed_at: new Date(now).toISOString() },
      },
    }));
  }

  const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();
  if (scenario === 'completed') {
    dirs.set('/tmp/test/claws', [{ name: 'claw1', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1', [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract', [{ name: 'archive', isDirectory: true, size: 0 }]);
    dirs.set('/tmp/test/claws/claw1/contract/archive', [{ name: 'contract-a', isDirectory: true, size: 0 }]);
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

function makeOpts(overrides: Partial<{
  fs: FileSystem;
  motionAudit: AuditLog;
  notifyClaw: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    clawforumRoot: '/tmp/test',
    fs: makeFsMock('empty'),
    motionAudit: makeAuditMock(),
    notifyClaw: vi.fn(),
    ...overrides,
  };
}

describe('Phase 542 — contract-observer deps 装配方注入', () => {
  it('completed contract events → notifyClaw called', async () => {
    const opts = makeOpts({ fs: makeFsMock('completed') });
    await runContractObserver(opts);
    expect(opts.notifyClaw).toHaveBeenCalledWith(
      opts.fs,
      opts.clawforumRoot,
      'motion',
      expect.objectContaining({ type: 'contract_events' }),
      opts.motionAudit,
    );
  });

  it('no events → notifyClaw NOT called', async () => {
    const opts = makeOpts({ fs: makeFsMock('empty') });
    await runContractObserver(opts);
    expect(opts.notifyClaw).not.toHaveBeenCalled();
  });
});
