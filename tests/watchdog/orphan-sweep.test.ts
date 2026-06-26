import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config/config-load.js';
import { setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { sweepOrphanWatchdogs } from '../../src/watchdog/orphan-sweep.js';  // phase 276: hoist 4 dyn imports
const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockKill = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
  };
});
vi.mock('../../src/assembly/config/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/config-loader.js')>();
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
  buildLLMConfig: vi.fn(),
}));

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    findProcesses: mockFindProcesses,
  })),
}));

describe('watchdog orphan sweep', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    tmpDir = path.join(os.tmpdir(), `wd-sweep-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');

    mockFindProcesses.mockReturnValue([]);
    mockKill.mockImplementation(() => {});
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

      mockFindProcesses.mockReturnValue([1000, 2000, 3000]);

      const sweepPromise = sweepOrphanWatchdogs(fsFactory, {}, { kill: mockKill });
      await vi.advanceTimersByTimeAsync(1001);
      const killed = await sweepPromise;

      expect(killed).toEqual([2000, 3000]);
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

      mockFindProcesses.mockReturnValue([1000, 2000]);

      const sweepPromise = sweepOrphanWatchdogs(fsFactory, { excludePid: null }, { kill: mockKill });
      await vi.advanceTimersByTimeAsync(1001);
      const killed = await sweepPromise;

      expect(killed).toEqual([1000, 2000]);
      expect(mockKill).toHaveBeenCalledWith(1000, 'TERM');
      expect(mockKill).toHaveBeenCalledWith(2000, 'TERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('findProcesses throws → audit ORPHAN_SWEEP_FAILED phase=find + return []', async () => {

    mockFindProcesses.mockImplementation(() => {
      throw new Error('pgrep failed');
    });

    const killed = await sweepOrphanWatchdogs(fsFactory, {}, { kill: mockKill });

    expect(killed).toEqual([]);
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
      'phase=find',
      expect.stringContaining('pgrep failed'),
    );
  });

  it('SIGTERM failure on one pid audits failure + continues killing others', async () => {
    vi.useFakeTimers();
    try {

      mockFindProcesses.mockReturnValue([2000, 3000]);
      mockKill.mockImplementation((pid: number) => {
        if (pid === 2000) throw new Error('EPERM');
      });

      const sweepPromise = sweepOrphanWatchdogs(fsFactory, { excludePid: null }, { kill: mockKill });
      await vi.advanceTimersByTimeAsync(1001);
      const killed = await sweepPromise;

      expect(killed).toEqual([3000]);
      expect(auditSpy).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
        'phase=sigterm',
        'pid=2000',
        expect.stringContaining('EPERM'),
      );
      expect(mockKill).toHaveBeenCalledWith(3000, 'TERM');
    } finally {
      vi.useRealTimers();
    }
  });
});
