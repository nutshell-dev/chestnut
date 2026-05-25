import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { setAuditWriter } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockKill = vi.hoisted(() => vi.fn());

vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

vi.mock('../../src/cli/utils/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    findProcesses: mockFindProcesses,
  })),
}));

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    kill: mockKill,
  };
});

describe('watchdog orphan sweep', () => {
  let tmpDir: string;
  let clawforumDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-sweep-${randomUUID()}`);
    clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: clawforumDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');

    mockFindProcesses.mockReturnValue([]);
    mockKill.mockImplementation(() => {});
  });

  afterEach(() => {
    setAuditWriter(null);
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sweep kills orphan watchdogs excluding pid-file one + audits ORPHAN_SWEEP_KILLED', async () => {
    const { sweepOrphanWatchdogs } = await import('../../src/watchdog/orphan-sweep.js');

    const pidFile = path.join(clawforumDir, 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 1000, root: '/test/root' }));

    mockFindProcesses.mockReturnValue([1000, 2000, 3000]);

    const killed = await sweepOrphanWatchdogs();

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
  });

  it('excludePid=null kills all including pid-file one', async () => {
    const { sweepOrphanWatchdogs } = await import('../../src/watchdog/orphan-sweep.js');

    mockFindProcesses.mockReturnValue([1000, 2000]);

    const killed = await sweepOrphanWatchdogs({ excludePid: null });

    expect(killed).toEqual([1000, 2000]);
    expect(mockKill).toHaveBeenCalledWith(1000, 'TERM');
    expect(mockKill).toHaveBeenCalledWith(2000, 'TERM');
  });

  it('findProcesses throws → audit ORPHAN_SWEEP_FAILED phase=find + return []', async () => {
    const { sweepOrphanWatchdogs } = await import('../../src/watchdog/orphan-sweep.js');

    mockFindProcesses.mockImplementation(() => {
      throw new Error('pgrep failed');
    });

    const killed = await sweepOrphanWatchdogs();

    expect(killed).toEqual([]);
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
      'phase=find',
      expect.stringContaining('pgrep failed'),
    );
  });

  it('SIGTERM failure on one pid audits failure + continues killing others', async () => {
    const { sweepOrphanWatchdogs } = await import('../../src/watchdog/orphan-sweep.js');

    mockFindProcesses.mockReturnValue([2000, 3000]);
    mockKill.mockImplementation((pid: number) => {
      if (pid === 2000) throw new Error('EPERM');
    });

    const killed = await sweepOrphanWatchdogs({ excludePid: null });

    expect(killed).toEqual([3000]);
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_FAILED,
      'phase=sigterm',
      'pid=2000',
      expect.stringContaining('EPERM'),
    );
    expect(mockKill).toHaveBeenCalledWith(3000, 'TERM');
  });
});
