/**
 * stop — orphan cleanup silent → audit (P1.4)
 *
 * 验证点：
 * 1. kill TERM 失败时写 ORPHAN_SIGTERM_FAILED audit
 * 2. 外层 cleanup pipeline 失败时写 PROCESS_LIST_FAILED audit
 * 3. audit 构造失败时 fallback null + 不抛
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

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
const mockIsPidArgvMatching = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockIsAlive = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([99991, 99992]));
const mockStopWatchdog = vi.hoisted(() => vi.fn());
// phase 1879 Step D: stop.ts audit 创建经 actionAuditFor（无 scope 回落 createDirContext）——
// mock 目标随创建点统一迁移（返回 { fs, audit } 形状）。
const mockCreateDirContext = vi.hoisted(() => vi.fn(() => ({
  fs: {},
  audit: {
    write: mockAuditState.write,
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  },
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

// phase 880 Step C: orphan-sweep uses real timers + real kill in its fallback path;
// in unit tests we only care about stopAllCommand's own cleanup loop, so bypass sweep
// to remove timing noise and cross-test side effects.
vi.mock('../../src/watchdog/orphan-sweep.js', () => ({
  sweepOrphanWatchdogs: vi.fn().mockResolvedValue({ kind: 'clear', killed: [], skipped: [], failures: [] }),
}));

vi.mock('../../src/cli/commands/motion.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/watchdog/watchdog-control.js', () => ({
  stopWatchdog: mockStopWatchdog,
}));

// phase 880 Step C: shrink stopProcess polling grace so tests don't spend 7s each
// waiting on real timers (flaky under load / close to testTimeout).
vi.mock('../../src/foundation/process-manager/constants.js', () => ({
  DAEMON_SHUTDOWN_GRACE_MS: 50,
  PROCESS_STOP_POLL_INTERVAL_MS: 5,
  SIGKILL_DEAD_VERIFY_GRACE_MS: 5,
  SPAWN_POLL_INTERVAL_MS: 5,
}));

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    isAlive: vi.fn().mockReturnValue(false),
    stop: vi.fn().mockResolvedValue(undefined),
    findProcessesSyncForCli: mockFindProcesses,
  })),
}));

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
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
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
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CliError } from '../../src/cli/errors.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const stopDeps = { fsFactory, rootConfig: { loadGlobal: vi.fn() } };

describe('stop — orphan cleanup silent → audit (P1.4)', () => {
  beforeEach(() => {
    mockAuditState.clear();
    vi.clearAllMocks();
    // phase 880 Step C: clearAllMocks does not reset implementations. Reset each
    // hoisted mock back to a known default so one test's mockImplementation cannot
    // leak into the next test.
    mockKill.mockReset().mockImplementation(() => {});
    mockFindProcesses.mockReset().mockReturnValue([99991, 99992]);
    mockIsAlive.mockReset().mockReturnValue(false);
    mockIsPidArgvMatching.mockReset().mockReturnValue(true);
    mockStopWatchdog.mockReset().mockResolvedValue({ kind: 'not_running', reason: 'no_process' });
    mockCreateDirContext.mockReset().mockImplementation(() => ({
      fs: {},
      audit: {
        write: mockAuditState.write,
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      },
    }));
  });

  it('kill TERM 失败时写 ORPHAN_SIGTERM_FAILED audit', async () => {
    mockKill.mockImplementation(() => {
      throw new Error('EPERM');
    });
    mockFindProcesses.mockReturnValue([1111, 2222]);
    mockCreateDirContext.mockReturnValue({
      fs: {},
      audit: {
        write: mockAuditState.write,
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      },
    });

    await expect(stopAllCommand(stopDeps, {
      kill: mockKill,
      isPidArgvMatching: mockIsPidArgvMatching,
      isAlive: () => true,
    })).rejects.toBeInstanceOf(CliError);

    const sigtermEvents = mockAuditState.events.filter(e => e[0] === 'orphan_sigterm_failed');
    expect(sigtermEvents).toHaveLength(2);
    expect(sigtermEvents[0]).toEqual(
      expect.arrayContaining([
        'orphan_sigterm_failed',
        'pid=1111',
        'context=stop_all_orphan_cleanup',
        expect.stringContaining('reason=EPERM'),
      ]),
    );
    expect(sigtermEvents[1]).toEqual(
      expect.arrayContaining([
        'orphan_sigterm_failed',
        'pid=2222',
        'context=stop_all_orphan_cleanup',
        expect.stringContaining('reason=EPERM'),
      ]),
    );
  });

  it('外层 cleanup pipeline 失败时写 PROCESS_LIST_FAILED audit', async () => {
    mockKill.mockImplementation(() => {});
    mockFindProcesses.mockImplementation(() => {
      throw new Error('some pipeline error');
    });
    mockCreateDirContext.mockReturnValue({ fs: {}, audit: { write: mockAuditState.write } });

    await expect(
      stopAllCommand(stopDeps, { kill: mockKill, isPidArgvMatching: mockIsPidArgvMatching }),
    ).rejects.toBeInstanceOf(CliError);

    const listFailedEvents = mockAuditState.events.filter(e => e[0] === 'process_list_failed');
    expect(listFailedEvents).toHaveLength(1);
    expect(listFailedEvents[0]).toEqual(
      expect.arrayContaining([
        'process_list_failed',
        'context=stop_all_cleanup_pipeline',
        expect.stringContaining('reason=some pipeline error'),
      ]),
    );
  });

  it('audit 构造失败时 fallback null + 不抛', async () => {
    mockKill.mockImplementation(() => {});
    mockFindProcesses.mockReturnValue([3333]);
    mockCreateDirContext.mockImplementation(() => {
      throw new Error('audit init failed');
    });

    // 不应抛错
    await expect(stopAllCommand(stopDeps)).resolves.not.toThrow();

    // audit 为 null，所以没有任何 audit 事件
    expect(mockAuditState.events).toHaveLength(0);
  });

  it('global marker failure is audited and prevents a clean Done terminal', async () => {
    mockFindProcesses.mockReturnValue([]);
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('marker read-only');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(stopAllCommand(stopDeps)).rejects.toThrow('clean-stop markers: global failed');
      expect(mockAuditState.events).toContainEqual(expect.arrayContaining([
        'cli_daemon_stop',
        'scope=all',
        'status=clean_stop_marker_failed',
        expect.stringContaining('operation_id='),
        expect.stringContaining('marker read-only'),
      ]));
      expect(log).not.toHaveBeenCalledWith('Done.');
    } finally {
      log.mockRestore();
    }
  });

  it('per-claw marker failure reaches the aggregate terminal after cleanup', async () => {
    mockFindProcesses.mockReturnValue([]);
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: 'alpha', isDirectory: () => true },
    ] as any);
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      stop: vi.fn().mockResolvedValue({ kind: 'stopped', pid: 123, via: 'sigterm' }),
      findProcessesSyncForCli: mockFindProcesses,
    } as any);
    vi.mocked(fs.writeFileSync)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error('claw marker EIO'); });

    await expect(stopAllCommand(stopDeps)).rejects.toThrow('clean-stop markers: alpha failed');
    expect(mockAuditState.events).toContainEqual(expect.arrayContaining([
      'cli_claw_stop',
      'name=alpha',
      'status=clean_stop_marker_failed',
      expect.stringContaining('claw marker EIO'),
    ]));
  });

  it('Done is emitted only after orphan discovery and cleanup finish', async () => {
    const order: string[] = [];
    mockFindProcesses.mockImplementation(() => {
      order.push('discovery');
      return [];
    });
    const log = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      if (message === 'Done.') order.push('done');
    });
    try {
      await stopAllCommand(stopDeps);
      expect(order).toEqual(['discovery', 'done']);
    } finally {
      log.mockRestore();
    }
  });

  it('orphan SIGTERM 无效后升级 SIGKILL 并验证死亡', async () => {
    mockKill.mockImplementation((_pid: number, signal: string | number) => {
      if (signal === 'KILL') {
        mockIsAlive.mockReturnValue(false);
      }
    });
    mockFindProcesses.mockReturnValue([4444]);
    mockIsAlive.mockReturnValue(true);
    mockCreateDirContext.mockReturnValue({
      fs: {},
      audit: {
        write: mockAuditState.write,
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      },
    });

    await stopAllCommand(stopDeps, { kill: mockKill, isPidArgvMatching: mockIsPidArgvMatching, isAlive: mockIsAlive });

    // TERM + KILL 各一次
    const termCalls = mockKill.mock.calls.filter(c => c[1] === 'TERM');
    const killCalls = mockKill.mock.calls.filter(c => c[1] === 'KILL');
    expect(termCalls).toHaveLength(1);
    expect(killCalls).toHaveLength(1);
    // 无残留 audit
    const partialEvents = mockAuditState.events.filter(e => e[0] === 'orphan_cleanup_partial');
    expect(partialEvents).toHaveLength(0);
  });

  it('orphan SIGKILL 后仍存活时写 ORPHAN_CLEANUP_PARTIAL audit', async () => {
    mockKill.mockImplementation(() => {});
    mockFindProcesses.mockReturnValue([5555]);
    mockIsAlive.mockReturnValue(true);
    mockCreateDirContext.mockReturnValue({
      fs: {},
      audit: {
        write: mockAuditState.write,
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      },
    });

    await expect(
      stopAllCommand(stopDeps, { kill: mockKill, isPidArgvMatching: mockIsPidArgvMatching, isAlive: mockIsAlive }),
    ).rejects.toBeInstanceOf(CliError);

    const partialEvents = mockAuditState.events.filter(e => e[0] === 'orphan_cleanup_partial');
    expect(partialEvents).toHaveLength(1);
    expect(partialEvents[0]).toEqual(
      expect.arrayContaining([
        'orphan_cleanup_partial',
        'pids=5555',
        'context=stop_all_orphan_sigkill_survived',
      ]),
    );
  });
});
