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
const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockGetWatchdogPid = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockIsWatchdogAlive = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockRemoveWatchdogPid = vi.hoisted(() => vi.fn());

// ============================================================================
// Module mocks
// ============================================================================
vi.mock('../../src/core/claw-topology/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/index.js')>();
  return {
    ...actual,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    getWorkspaceRoot: vi.fn(() => '/tmp/test'),
  };
});

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    kill: mockKill,
    isAlive: mockIsAlive,
    isPidArgvMatching: mockIsPidArgvMatching,
  };
});

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    findProcesses: mockFindProcesses,
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

vi.mock('../../src/watchdog/watchdog-pid.js', () => ({
  getWatchdogPid: mockGetWatchdogPid,
  isWatchdogAlive: mockIsWatchdogAlive,
  removeWatchdogPid: mockRemoveWatchdogPid,
  WatchdogPidForeignWorkspaceError: class WatchdogPidForeignWorkspaceError extends Error {
    constructor(public foreignPid: number, public foreignRoot: string, public currentRoot: string) {
      super(`foreign workspace`);
    }
  },
}));

vi.mock('timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================
import { stopCommand } from '../../src/watchdog/watchdog-cli.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('watchdog-cli stopCommand pgrep fallback (phase 804)', () => {
  beforeEach(() => {
    mockAuditState.clear();
    vi.clearAllMocks();
    mockGetWatchdogPid.mockReturnValue(null);
    mockIsWatchdogAlive.mockReturnValue(false);
  });

  it('PID file missing and pgrep finds no process → reports not running', async () => {
    mockFindProcesses.mockReturnValue([]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopCommand(fsFactory);

    expect(consoleSpy).toHaveBeenCalledWith('Watchdog is not running');
    expect(mockRemoveWatchdogPid).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('PID file missing but pgrep finds watchdog → sends SIGTERM and stops', async () => {
    mockFindProcesses.mockReturnValue([7777]);
    mockIsAlive.mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopCommand(fsFactory);

    const termCalls = mockKill.mock.calls.filter(c => c[1] === 'TERM');
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0][0]).toBe(7777);
    expect(consoleSpy).toHaveBeenCalledWith('Watchdog stopped');
    consoleSpy.mockRestore();
  });

  it('PID file missing, watchdog survives SIGTERM → escalates to SIGKILL', async () => {
    mockFindProcesses.mockReturnValue([8888]);
    mockIsAlive.mockReturnValue(true);
    mockKill.mockImplementation((_pid: number, signal: string | number) => {
      if (signal === 'KILL') {
        mockIsAlive.mockReturnValue(false);
      }
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopCommand(fsFactory);

    const termCalls = mockKill.mock.calls.filter(c => c[1] === 'TERM');
    const killCalls = mockKill.mock.calls.filter(c => c[1] === 'KILL');
    expect(termCalls).toHaveLength(1);
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0][0]).toBe(8888);
    consoleSpy.mockRestore();
  });

  it('PID file missing, pgrep throws → conservative not running', async () => {
    mockFindProcesses.mockImplementation(() => {
      throw new Error('pgrep unavailable');
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopCommand(fsFactory);

    expect(consoleSpy).toHaveBeenCalledWith('Watchdog is not running');
    expect(mockKill).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
