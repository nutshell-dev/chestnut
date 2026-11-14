/**
 * watchdog-cli stopCommand pgrep fallback (phase 804)
 *
 * 验证点：
 * 1. PID 文件缺失但 pgrep 找到 watchdog → 发送 SIGTERM 并停止
 * 2. PID 文件缺失且 pgrep 未找到 → 报 not running
 * 3. PID 文件缺失、进程存活、SIGTERM 无效 → 升级 SIGKILL
 */
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

const mockKill = vi.hoisted(() => vi.fn());
const mockIsAlive = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockIsPidArgvMatching = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockFindProcesses = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockGetWatchdogPid = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockGetWatchdogProcessTarget = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockIsWatchdogAlive = vi.hoisted(() => vi.fn().mockReturnValue('not_running'));
const mockInspectWatchdogOwner = vi.hoisted(() => vi.fn(() => ({ kind: 'none' })));
const mockRemoveWatchdogPid = vi.hoisted(() => vi.fn());

// ============================================================================
// Module mocks
// ============================================================================
// phase 1864 Step B：路径 API 归 foundation/claw-identity（mock 目标随 owner 迁移）。
// Phase 1930 Step B：getWorkspaceRoot 退役；stop fallback PM 的 baseDir 改真实实例根。
vi.mock('../../src/foundation/claw-identity/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/index.js')>();
  return {
    ...actual,
    getChestnutRoot: vi.fn(() => '/tmp/test/.chestnut'),
  };
});

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    kill: mockKill,
    isAlive: mockIsAlive,
    isPidArgvMatching: mockIsPidArgvMatching,
    observeProcessTarget: (target: { pid: number }) => {
      const evidence = { version: 1 as const, atMs: 0, facts: [] };
      const alive = mockIsAlive(target.pid);
      if (!alive) return { kind: 'gone', reason: 'absent', evidence };
      return mockIsPidArgvMatching(target.pid)
        ? { kind: 'alive', evidence }
        : { kind: 'gone', reason: 'identity_changed', evidence };
    },
  };
});

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    findProcessesAsync: mockFindProcesses,
  })),
}));

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

vi.mock('../../src/watchdog/watchdog-pid.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-pid.js')>();
  return {
    ...actual,
  getWatchdogPid: mockGetWatchdogPid,
  getWatchdogProcessTarget: mockGetWatchdogProcessTarget,
  inspectWatchdogOwner: mockInspectWatchdogOwner,
  inspectWatchdogLivenessForCli: mockIsWatchdogAlive,
  removeWatchdogPid: mockRemoveWatchdogPid,
  WatchdogPidForeignWorkspaceError: class WatchdogPidForeignWorkspaceError extends Error {
    constructor(public foreignPid: number, public foreignRoot: string, public currentRoot: string) {
      super(`foreign workspace`);
    }
  }
  };
});

vi.mock('timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================
import { stopCommand } from '../../src/cli/commands/watchdog-cli.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('watchdog-cli stopCommand pgrep fallback (phase 804)', () => {
  beforeEach(() => {
    mockAuditState.clear();
    vi.clearAllMocks();
    mockGetWatchdogPid.mockReturnValue(null);
    mockGetWatchdogProcessTarget.mockReturnValue(null);
    mockIsWatchdogAlive.mockReturnValue(false);
    mockFindProcesses.mockResolvedValue([]);
    mockIsAlive.mockReturnValue(false);
    mockIsPidArgvMatching.mockReturnValue(true);
    mockKill.mockImplementation(() => {});
  });

  it('PID file missing and pgrep finds no process → reports not running', async () => {
    mockFindProcesses.mockResolvedValue([]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopCommand(fsFactory);

    expect(consoleSpy).toHaveBeenCalledWith('Watchdog is not running');
    expect(mockRemoveWatchdogPid).toHaveBeenCalled();
    // Phase 1930 Step B：fallback PM baseDir 是真实实例根（审计落点在实例内）。
    expect(createProcessManagerForCLI).toHaveBeenCalledWith(
      expect.objectContaining({ baseDir: '/tmp/test/.chestnut' }),
    );
    consoleSpy.mockRestore();
  });

  it('PID file missing but pgrep finds watchdog → sends SIGTERM and stops', async () => {
    mockFindProcesses.mockResolvedValue([7777]);
    mockIsAlive.mockReturnValue(false)
      .mockReturnValueOnce(true)  // fallback identity observation
      .mockReturnValueOnce(true); // termination pre-signal observation
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopCommand(fsFactory, {
      terminateProcessTarget: async target => {
        mockKill(target.pid, 'TERM');
        return {
          kind: 'gone', via: 'sigterm', termSent: true, killSent: false,
          evidence: { version: 1, atMs: 0, facts: [] },
        };
      },
    });

    const termCalls = mockKill.mock.calls.filter(c => c[1] === 'TERM');
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0][0]).toBe(7777);
    expect(consoleSpy).toHaveBeenCalledWith('Watchdog stopped');
    consoleSpy.mockRestore();
  });

  it('PID file missing, watchdog survives SIGTERM → escalates to SIGKILL', async () => {
    mockFindProcesses.mockResolvedValue([8888]);
    mockIsAlive.mockReturnValue(true);
    mockKill.mockImplementation((_pid: number, signal: string | number) => {
      if (signal === 'KILL') {
        mockIsAlive.mockReturnValue(false);
      }
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopCommand(fsFactory, {
      terminateProcessTarget: async target => {
        mockKill(target.pid, 'TERM');
        mockKill(target.pid, 'KILL');
        return {
          kind: 'gone', via: 'sigkill', termSent: true, killSent: true,
          evidence: { version: 1, atMs: 0, facts: [] },
        };
      },
    });

    const termCalls = mockKill.mock.calls.filter(c => c[1] === 'TERM');
    const killCalls = mockKill.mock.calls.filter(c => c[1] === 'KILL');
    expect(termCalls).toHaveLength(1);
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0][0]).toBe(8888);
    consoleSpy.mockRestore();
  });

  it('confirmation timeout rejects without claiming stopped or removing legacy evidence', async () => {
    mockFindProcesses.mockResolvedValue([8888]);
    mockIsAlive.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(stopCommand(fsFactory, {
      terminateProcessTarget: async () => ({
        kind: 'still_alive', termSent: true, killSent: true,
        evidence: { version: 1, atMs: 0, facts: [] },
      }),
    })).rejects.toThrow(/stop was not confirmed/);

    expect(consoleSpy).not.toHaveBeenCalledWith('Watchdog stopped');
    expect(mockRemoveWatchdogPid).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('permission-denied observation rejects without issuing a signal', async () => {
    mockFindProcesses.mockResolvedValue([8888]);
    const permission = Object.assign(new Error('denied'), { code: 'EPERM' });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(stopCommand(fsFactory, {
      observeProcessTarget: () => ({
        kind: 'unknown', reason: 'permission_denied', error: permission,
        evidence: { version: 1, atMs: 0, facts: [] },
      }),
    })).rejects.toThrow(/stop was not confirmed/);

    expect(consoleSpy).not.toHaveBeenCalledWith('Watchdog stopped');
    expect(mockKill).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('PID file missing, pgrep throws → indeterminate failure, never a stopped claim', async () => {
    mockFindProcesses.mockRejectedValue(new Error('pgrep unavailable'));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(stopCommand(fsFactory)).rejects.toThrow(/stop was not confirmed/);

    expect(consoleSpy).not.toHaveBeenCalledWith('Watchdog stopped');
    expect(mockKill).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
