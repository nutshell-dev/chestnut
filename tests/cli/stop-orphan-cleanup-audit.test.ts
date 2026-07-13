/**
 * stop — orphan cleanup silent → audit (P1.4)
 *
 * 验证点：
 * 1. kill TERM 失败时写 ORPHAN_SIGTERM_FAILED audit
 * 2. 外层 cleanup pipeline 失败时写 PROCESS_LIST_FAILED audit
 * 3. audit 构造失败时 fallback null + 不抛
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
const mockIsPidArgvMatching = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockIsAlive = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([99991, 99992]));
const mockCreateSystemAudit = vi.hoisted(() => vi.fn(() => ({
  write: mockAuditState.write,
  preview: (s: string) => s,
  message: (s: string) => s,
  summary: (s: string) => s,
})));

// ============================================================================
// Module mocks
// ============================================================================
vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    getNamedSubrootDir: vi.fn(() => '/tmp/test/.chestnut/motion'),
  };
});
vi.mock('../../src/assembly/config/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/global-config-path.js')>();
  return {
    ...actual,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    getGlobalConfigPath: vi.fn(() => '/tmp/test/.chestnut/config.yaml'),
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

vi.mock('../../src/watchdog/watchdog.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
}));

// phase 880 Step C: orphan-sweep uses real timers + real kill in its fallback path;
// in unit tests we only care about stopAllCommand's own cleanup loop, so bypass sweep
// to remove timing noise and cross-test side effects.
vi.mock('../../src/watchdog/orphan-sweep.js', () => ({
  sweepOrphanWatchdogs: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/cli/commands/motion.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
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
    findProcesses: mockFindProcesses,
  })),
}));

vi.mock('../../src/foundation/audit/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/audit/index.js')>();
  return {
    ...actual,
    createSystemAudit: mockCreateSystemAudit,
    createAuditWriter: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readdirSync: vi.fn().mockReturnValue([]),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

// ============================================================================
// Imports (after mocks)
// ============================================================================
import { stopAllCommand } from '../../src/cli/commands/stop.js';
import { createSystemAudit } from '../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

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
    mockCreateSystemAudit.mockReset().mockImplementation(() => ({
      write: mockAuditState.write,
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    }));
  });

  it('kill TERM 失败时写 ORPHAN_SIGTERM_FAILED audit', async () => {
    mockKill.mockImplementation(() => {
      throw new Error('EPERM');
    });
    mockFindProcesses.mockReturnValue([1111, 2222]);
    mockCreateSystemAudit.mockReturnValue({
      write: mockAuditState.write,
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    });

    await stopAllCommand({ fsFactory }, { kill: mockKill, isPidArgvMatching: mockIsPidArgvMatching });

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
    mockCreateSystemAudit.mockReturnValue({ write: mockAuditState.write });

    await stopAllCommand({ fsFactory }, { kill: mockKill, isPidArgvMatching: mockIsPidArgvMatching });

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
    mockCreateSystemAudit.mockImplementation(() => {
      throw new Error('audit init failed');
    });

    // 不应抛错
    await expect(stopAllCommand({ fsFactory })).resolves.not.toThrow();

    // audit 为 null，所以没有任何 audit 事件
    expect(mockAuditState.events).toHaveLength(0);
  });

  it('orphan SIGTERM 无效后升级 SIGKILL 并验证死亡', async () => {
    mockKill.mockImplementation((_pid: number, signal: string | number) => {
      if (signal === 'KILL') {
        mockIsAlive.mockReturnValue(false);
      }
    });
    mockFindProcesses.mockReturnValue([4444]);
    mockIsAlive.mockReturnValue(true);
    mockCreateSystemAudit.mockReturnValue({
      write: mockAuditState.write,
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    });

    await stopAllCommand({ fsFactory }, { kill: mockKill, isPidArgvMatching: mockIsPidArgvMatching, isAlive: mockIsAlive });

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
    mockCreateSystemAudit.mockReturnValue({
      write: mockAuditState.write,
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    });

    await stopAllCommand({ fsFactory }, { kill: mockKill, isPidArgvMatching: mockIsPidArgvMatching, isAlive: mockIsAlive });

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
