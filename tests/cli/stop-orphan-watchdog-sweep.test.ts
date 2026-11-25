import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Hoisted mock state
// ============================================================================
const mockAuditState = vi.hoisted(() => {
  const events: Array<[string, ...(string | number)[]]> = [];
  return {
    events,
    clear: () => { events.length = 0; },
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
});

const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([99991, 99992]));
const mockFindProcessesAsync = vi.hoisted(() => vi.fn().mockResolvedValue([99991, 99992]));
const mockKill = vi.hoisted(() => vi.fn());
const mockIsAlive = vi.hoisted(() => vi.fn());
const mockLivePids = vi.hoisted(() => new Set<number>());
const mockStopWatchdog = vi.hoisted(() => vi.fn());
const mockMotionStop = vi.hoisted(() => vi.fn());
const mockClawStop = vi.hoisted(() => vi.fn());
// phase 1879 Step D: stop.ts audit 创建经 actionAuditFor（无 scope 回落 createDirContext）——
// mock 目标随创建点统一迁移（返回 { fs, audit } 形状）。
const mockCreateDirContext = vi.hoisted(() => vi.fn(() => ({
  fs: {},
  audit: { write: mockAuditState.write },
})));

// ============================================================================
// Module mocks
// ============================================================================
vi.mock('../../src/foundation/claw-identity/instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(() => '/tmp/test/.chestnut/motion'),
  };
});
vi.mock('../../src/assembly/config/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/global-config-path.js')>();
  return {
    ...actual,
    getGlobalConfigPath: vi.fn(() => '/tmp/test/.chestnut/config.yaml'),
  };
});
vi.mock('../../src/foundation/config-store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config-store/index.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/watchdog/watchdog.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
  getWatchdogPid: vi.fn().mockReturnValue(null),
  inspectWatchdogLivenessForCli: vi.fn().mockReturnValue('not_running'),
  removeWatchdogPid: vi.fn(),
}));

vi.mock('../../src/cli/commands/motion.js', () => ({
  stopCommand: mockMotionStop,
}));

vi.mock('../../src/watchdog/watchdog-control.js', () => ({
  stopWatchdog: mockStopWatchdog,
}));

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    liveness: vi.fn().mockReturnValue({ kind: 'dead', pid: 12345, evidence: { version: 1, atMs: 0, facts: [] } }),
    stop: mockClawStop,
    findProcessesSyncForCli: mockFindProcesses,
    findProcessesAsync: mockFindProcessesAsync,
  })),
}));

// Mock process-exec to no-op kill/isAlive — avoid hitting real OS (CI may have
// system processes at low pids like 1111 causing EPERM throws → test flake).
// Previously without mock, kill(1111) threw EPERM on CI but ESRCH-silent on local dev.
vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    kill: mockKill,
    isAlive: mockIsAlive,
    observeProcessTarget: (target: { pid: number }) => ({
      kind: mockIsAlive(target.pid) ? 'alive' : 'gone',
      reason: 'absent',
      evidence: { version: 1, atMs: 0, facts: [] },
    }),
  };
});

vi.mock('../../src/watchdog/watchdog-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-context.js')>();
  return {
    ...actual,
    getWatchdogEntryPath: vi.fn(() => '/fake/watchdog-entry.js'),
    getAuditWriter: vi.fn(() => ({
      write: mockAuditState.write,
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    })),
  };
});

vi.mock('../../src/foundation/audit/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/audit/index.js')>();
  return {
    ...actual,
    createDirContext: mockCreateDirContext,
    // Phase 1288 Step C: stop 根审计构造切到 createWorkspaceAudit（mock 防真实磁盘写入）
    createWorkspaceAudit: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readdirSync: vi.fn().mockReturnValue([]),
    writeFileSync: vi.fn(),
    openSync: vi.fn().mockReturnValue(1),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

// ============================================================================
// Imports (after mocks)
// ============================================================================
import { stopAllCommand } from '../../src/cli/commands/stop.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const stopDeps = { fsFactory };

describe('stop — orphan watchdog sweep (phase 1269 sub-4)', () => {
  beforeEach(() => {
    _resetWatchdogContextForTest();
    mockAuditState.clear();
    vi.clearAllMocks();
    mockLivePids.clear();
    mockFindProcesses.mockReset().mockReturnValue([]);
    mockFindProcessesAsync.mockReset().mockResolvedValue([]);
    mockStopWatchdog.mockReset().mockResolvedValue({ kind: 'not_running', reason: 'no_process' });
    mockMotionStop.mockReset().mockResolvedValue({ kind: 'stopped', pid: 12345, via: 'already_dead' });
    mockClawStop.mockReset().mockResolvedValue({ kind: 'stopped', pid: 12345, via: 'already_dead' });
    mockIsAlive.mockImplementation((pid: number) => mockLivePids.has(pid));
    mockKill.mockImplementation((pid: number) => { mockLivePids.delete(pid); });
  });

  it('stopAllCommand sweeps orphan watchdogs + audits ORPHAN_SWEEP_KILLED', async () => {
    mockFindProcesses.mockReturnValue([]);
    mockFindProcessesAsync.mockResolvedValue([1111, 2222]);
    [1111, 2222].forEach(pid => mockLivePids.add(pid));
    mockCreateDirContext.mockReturnValue({ fs: {}, audit: { write: mockAuditState.write } });

    await stopAllCommand(stopDeps, { kill: mockKill, isAlive: mockIsAlive });

    const sweepEvents = mockAuditState.events.filter(e => e[0] === WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED);
    expect(sweepEvents).toHaveLength(1);
    expect(sweepEvents[0]).toEqual(
      expect.arrayContaining([
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED,
        'count=2',
        'pids=1111,2222',
        'kept=none',
      ]),
    );
  });

  it('continues sweep and read-only discovery but blocks downstream after Watchdog fails', async () => {
    const sentinel = new Error('watchdog stop sentinel');
    mockStopWatchdog.mockRejectedValueOnce(sentinel);
    mockFindProcessesAsync.mockResolvedValue([1111]);
    mockFindProcesses.mockReturnValue([2222]);
    mockLivePids.add(1111);
    const terminateTarget = vi.fn();

    await expect(stopAllCommand(stopDeps, {
      kill: mockKill,
      isAlive: mockIsAlive,
      terminateTarget,
    })).rejects.toThrow(/downstream blocked/);

    expect(mockFindProcessesAsync).toHaveBeenCalled();
    expect(mockFindProcesses).toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalledWith(1111, 'TERM');
    expect(mockMotionStop).not.toHaveBeenCalled();
    expect(mockClawStop).not.toHaveBeenCalled();
    expect(terminateTarget).not.toHaveBeenCalled();
  });

  it('blocks Motion, claws, and orphan termination when sweep is unconfirmed', async () => {
    mockFindProcessesAsync.mockRejectedValueOnce(new Error('watchdog process list unavailable'));
    mockFindProcesses.mockReturnValue([2222]);
    const terminateTarget = vi.fn();

    await expect(stopAllCommand(stopDeps, { terminateTarget })).rejects.toThrow(/downstream blocked/);
    expect(mockFindProcesses).toHaveBeenCalled();
    expect(mockMotionStop).not.toHaveBeenCalled();
    expect(mockClawStop).not.toHaveBeenCalled();
    expect(terminateTarget).not.toHaveBeenCalled();
  });
});
