import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/foundation/claw-identity/index.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { sweepOrphanWatchdogs } from '../../src/watchdog/orphan-sweep.js';  // phase 276: hoist 4 dyn imports
const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const mockFindProcesses = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockKill = vi.hoisted(() => vi.fn());
const mockIsAlive = vi.hoisted(() => vi.fn());
const mockLivePids = vi.hoisted(() => new Set<number>());

vi.mock('../../src/foundation/claw-identity/instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
  };
});
vi.mock('../../src/foundation/config-store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config-store/index.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
}));

// Phase 1289 Step C: watchdog runtime 消费自家 workspace config store
vi.mock('../../src/watchdog/workspace-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/workspace-config.js')>();
  return {
    ...actual,
    readWorkspaceWatchdogConfig: vi.fn(),
  };
});

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    findProcessesAsync: mockFindProcesses,
  })),
}));

function processDeps(argvMatches = true) {
  return {
    kill: mockKill,
    observeProcessTarget: (target: { pid: number }) => {
      const evidence = { version: 1 as const, atMs: 0, facts: [] };
      if (!mockIsAlive(target.pid)) return { kind: 'gone', reason: 'absent', evidence };
      return argvMatches
        ? { kind: 'alive', evidence }
        : { kind: 'gone', reason: 'identity_changed', evidence };
    },
  };
}

describe('watchdog orphan sweep', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-sweep-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000,
    });

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');

    mockFindProcesses.mockResolvedValue([]);
    mockLivePids.clear();
    mockIsAlive.mockImplementation((pid: number) => mockLivePids.has(pid));
    mockKill.mockImplementation((pid: number) => { mockLivePids.delete(pid); });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sweep kills orphan watchdogs excluding pid-file one + audits ORPHAN_SWEEP_KILLED', async () => {
    vi.useFakeTimers();
    try {

      const pidFile = path.join(chestnutDir, 'watchdog.pid');
      fs.writeFileSync(pidFile, JSON.stringify({ pid: 1000, root: '/test/root' }));

      mockFindProcesses.mockResolvedValue([1000, 2000, 3000]);
      [2000, 3000].forEach(pid => mockLivePids.add(pid));

      const sweepPromise = sweepOrphanWatchdogs(fsFactory, {}, processDeps());
      await vi.advanceTimersByTimeAsync(1001);
      const outcome = await sweepPromise;

      expect(outcome).toMatchObject({ kind: 'clear', killed: [2000, 3000], failures: [] });
      expect(mockKill).toHaveBeenCalledWith(2000, 'TERM');
      expect(mockKill).toHaveBeenCalledWith(3000, 'TERM');
      expect(mockKill).not.toHaveBeenCalledWith(1000, expect.any(String));
      expect(auditSpy).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED,
        expect.stringContaining('count=2'),
        expect.stringContaining('pids=2000,3000'),
        expect.stringContaining('kept=1000'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludePid=null kills all including pid-file one', async () => {
    vi.useFakeTimers();
    try {

      mockFindProcesses.mockResolvedValue([1000, 2000]);
      [1000, 2000].forEach(pid => mockLivePids.add(pid));

      const sweepPromise = sweepOrphanWatchdogs(
        fsFactory, { excludePid: null }, processDeps(),
      );
      await vi.advanceTimersByTimeAsync(1001);
      const outcome = await sweepPromise;

      expect(outcome).toMatchObject({ kind: 'clear', killed: [1000, 2000] });
      expect(mockKill).toHaveBeenCalledWith(1000, 'TERM');
      expect(mockKill).toHaveBeenCalledWith(2000, 'TERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('findProcessesAsync throws → audit ORPHAN_SWEEP_FAILED phase=find + blocked outcome', async () => {

    mockFindProcesses.mockRejectedValue(new Error('pgrep failed'));

    const outcome = await sweepOrphanWatchdogs(fsFactory, {}, { kill: mockKill });

    expect(outcome).toMatchObject({ kind: 'blocked', killed: [] });
    expect(outcome.failures[0]).toMatchObject({ stage: 'find' });
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
      'phase=find',
      expect.stringContaining('pgrep failed'),
    );
  });

  it('SIGTERM failure on one pid audits failure + continues killing others', async () => {
    vi.useFakeTimers();
    try {

      mockFindProcesses.mockResolvedValue([2000, 3000]);
      [2000, 3000].forEach(pid => mockLivePids.add(pid));
      mockKill.mockImplementation((pid: number) => {
        if (pid === 2000) throw new Error('EPERM');
        mockLivePids.delete(pid);
      });

      const sweepPromise = sweepOrphanWatchdogs(
        fsFactory, { excludePid: null }, processDeps(),
      );
      await vi.advanceTimersByTimeAsync(1001);
      const outcome = await sweepPromise;

      expect(outcome).toMatchObject({ kind: 'partial', killed: [3000] });
      expect(outcome.failures[0]).toMatchObject({ pid: 2000, stage: 'sigterm' });
      expect(auditSpy).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
        'phase=sigterm',
        'pid=2000',
        expect.stringContaining('EPERM'),
        expect.stringContaining('evidence='),
      );
      expect(mockKill).toHaveBeenCalledWith(3000, 'TERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('PID reuse is skipped before any signal', async () => {
    mockFindProcesses.mockResolvedValue([2000]);
    mockLivePids.add(2000);

    const outcome = await sweepOrphanWatchdogs(fsFactory, { excludePid: null }, {
      ...processDeps(false),
    });

    expect(outcome).toMatchObject({ kind: 'clear', killed: [], skipped: [2000] });
    expect(mockKill).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_PID_REUSE_SKIPPED,
      'pid=2000',
      'reason=argv_not_watchdog',
    );
  });

  it('permission-denied observation stays blocked and never signals', async () => {
    mockFindProcesses.mockResolvedValue([2000]);
    const permission = Object.assign(new Error('denied'), { code: 'EPERM' });
    const outcome = await sweepOrphanWatchdogs(fsFactory, { excludePid: null }, {
      kill: mockKill,
      observeProcessTarget: () => ({
        kind: 'unknown', reason: 'permission_denied', error: permission,
        evidence: { version: 1, atMs: 0, facts: ['raw-evidence'] },
      }),
    });

    expect(outcome).toMatchObject({ kind: 'blocked', killed: [] });
    expect(outcome.failures[0]).toMatchObject({ pid: 2000, stage: 'observe', error: permission });
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('confirmation timeout is not reported as killed', async () => {
    vi.useFakeTimers();
    try {
      mockFindProcesses.mockResolvedValue([2000]);
      mockLivePids.add(2000);
      mockKill.mockImplementation(() => {});

      const pending = sweepOrphanWatchdogs(fsFactory, { excludePid: null }, processDeps());
      await vi.advanceTimersByTimeAsync(2200);
      const outcome = await pending;

      expect(outcome).toMatchObject({ kind: 'blocked', killed: [] });
      expect(outcome.failures[0]).toMatchObject({ pid: 2000, stage: 'confirm' });
      expect(mockKill).toHaveBeenCalledWith(2000, 'KILL');
      expect(auditSpy).not.toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED,
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
