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
import * as os from 'os';
import * as path from 'path';

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

const actualFsState = vi.hoisted(() => ({ value: undefined as unknown as typeof import('fs') }));
const mockKill = vi.hoisted(() => vi.fn());
const mockIsPidArgvMatching = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockIsAlive = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([99991, 99992]));
const mockStopWatchdog = vi.hoisted(() => vi.fn());
const mockMotionStop = vi.hoisted(() => vi.fn());
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
  stopCommand: mockMotionStop,
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
    stop: vi.fn().mockResolvedValue({ kind: 'stopped', pid: 12345, via: 'already_dead' }),
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
  actualFsState.value = actual;
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
import { makeProcessStartTime } from '../../src/foundation/process-exec/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const stopDeps = { fsFactory };

const evidence = { version: 1 as const, atMs: 0, facts: [] };
const startTime = makeProcessStartTime('start');
const alive = { kind: 'alive' as const, startTime, evidence };
const ownedDeps = (overrides: any = {}) => ({
  captureTarget: vi.fn((pid: number) => ({
    kind: 'captured', target: { pid, startTime }, evidence,
  })),
  observeTarget: vi.fn(() => alive),
  observeArgv: vi.fn(() => ({ kind: 'match', evidence })),
  observeCwd: vi.fn(async () => ({ kind: 'observed', cwd: '/workspace', evidence })),
  canonicalizePath: vi.fn(() => '/canonical/workspace'),
  ...overrides,
});

describe('stop — orphan cleanup silent → audit (P1.4)', () => {
  beforeEach(() => {
    mockAuditState.clear();
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReset().mockReturnValue([]);
    vi.mocked(fs.statSync).mockReset().mockReturnValue({ isDirectory: () => true });
    vi.mocked(fs.writeFileSync).mockReset().mockImplementation(() => {});
    vi.mocked(fs.openSync).mockReset().mockReturnValue(1);
    vi.mocked(fs.fsyncSync).mockReset().mockImplementation(() => {});
    vi.mocked(fs.closeSync).mockReset().mockImplementation(() => {});
    vi.mocked(fs.renameSync).mockReset().mockImplementation(() => {});
    vi.mocked(fs.unlinkSync).mockReset().mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReset().mockReturnValue(true);
    // phase 880 Step C: clearAllMocks does not reset implementations. Reset each
    // hoisted mock back to a known default so one test's mockImplementation cannot
    // leak into the next test.
    mockKill.mockReset().mockImplementation(() => {});
    mockFindProcesses.mockReset().mockReturnValue([]);
    mockIsAlive.mockReset().mockReturnValue(false);
    mockIsPidArgvMatching.mockReset().mockReturnValue(true);
    mockStopWatchdog.mockReset().mockResolvedValue({ kind: 'not_running', reason: 'no_process' });
    mockMotionStop.mockReset().mockResolvedValue({ kind: 'stopped', pid: 12345, via: 'already_dead' });
    vi.mocked(createProcessManagerForCLI).mockReset().mockImplementation(() => ({
      isAlive: vi.fn().mockReturnValue(false),
      stop: vi.fn().mockResolvedValue({ kind: 'stopped', pid: 12345, via: 'already_dead' }),
      findProcessesSyncForCli: mockFindProcesses,
    }));
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

    await expect(stopAllCommand(stopDeps, ownedDeps({
      kill: mockKill,
    }))).rejects.toBeInstanceOf(CliError);

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
    mockFindProcesses.mockReturnValue([]);
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

    let running = true;
    const observeTarget = vi.fn(() => running
      ? alive
      : { kind: 'gone' as const, reason: 'absent' as const, evidence });
    const cleanup = ownedDeps({ kill: mockKill, observeTarget });
    mockKill.mockImplementation((_pid: number, signal: string | number) => {
      if (signal === 'KILL') running = false;
    });

    await stopAllCommand(stopDeps, cleanup);

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
      stopAllCommand(stopDeps, ownedDeps({ kill: mockKill })),
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

  it('skips a foreign workspace using the same daemon entry and still succeeds', async () => {
    mockFindProcesses.mockReturnValue([6001]);
    const observeTarget = vi.fn(() => alive);
    const cleanup = ownedDeps({
      kill: mockKill,
      observeTarget,
      observeCwd: vi.fn(async () => ({ kind: 'observed', cwd: '/foreign/workspace', evidence })),
      canonicalizePath: (value: string) => value,
    });

    await expect(stopAllCommand(stopDeps, cleanup)).resolves.toBeUndefined();
    expect(mockKill).not.toHaveBeenCalled();
    expect(observeTarget).toHaveBeenCalledTimes(2);
    expect(cleanup.observeArgv).toHaveBeenCalledWith(6001, expect.stringMatching(/ motion$/));
  });

  it.each(['no_evidence', 'unknown', 'pid_reuse', 'incomplete_argv', 'cwd_unknown'] as const)(
    'fails closed without signals for %s',
    async scenario => {
      mockFindProcesses.mockReturnValue([6100]);
      const overrides: any = { kill: mockKill };
      if (scenario === 'no_evidence') {
        overrides.captureTarget = vi.fn(() => ({ kind: 'unknown', reason: 'query_failed', evidence }));
      } else if (scenario === 'unknown') {
        overrides.observeTarget = vi.fn(() => ({ kind: 'unknown', reason: 'timed_out', evidence }));
      } else if (scenario === 'pid_reuse') {
        overrides.observeTarget = vi.fn(() => ({ kind: 'gone', reason: 'identity_changed', evidence }));
      } else if (scenario === 'incomplete_argv') {
        overrides.observeArgv = vi.fn(() => ({ kind: 'mismatch', evidence }));
      } else {
        overrides.observeCwd = vi.fn(async () => ({ kind: 'unknown', reason: 'query_failed', evidence }));
      }

      await expect(stopAllCommand(stopDeps, ownedDeps(overrides))).rejects.toBeInstanceOf(CliError);
      expect(mockKill).not.toHaveBeenCalled();
    },
  );

  it('rechecks ownership before TERM and KILL', async () => {
    mockFindProcesses.mockReturnValue([6200]);
    let running = true;
    const observeTarget = vi.fn(() => running
      ? alive
      : { kind: 'gone' as const, reason: 'absent' as const, evidence });
    const observeCwd = vi.fn(async () => ({ kind: 'observed', cwd: '/workspace', evidence }));
    const observeArgv = vi.fn(() => ({ kind: 'match', evidence }));
    mockKill.mockImplementation((_pid: number, signal: string | number) => {
      if (signal === 'KILL') running = false;
    });

    await stopAllCommand(stopDeps, ownedDeps({
      kill: mockKill, observeTarget, observeCwd, observeArgv,
    }));

    expect(mockKill.mock.calls.map(call => call[1])).toEqual(['TERM', 'KILL']);
    // Initial classification plus the TERM and KILL ownership rechecks.
    expect(observeCwd).toHaveBeenCalledTimes(3);
    expect(observeArgv).toHaveBeenCalledTimes(3);
  });

  it('blocks KILL when cwd changes after TERM', async () => {
    mockFindProcesses.mockReturnValue([6300]);
    const observeCwd = vi.fn()
      .mockResolvedValueOnce({ kind: 'observed', cwd: '/workspace', evidence })
      .mockResolvedValueOnce({ kind: 'observed', cwd: '/workspace', evidence })
      .mockResolvedValue({ kind: 'observed', cwd: '/foreign/workspace', evidence });

    await expect(stopAllCommand(stopDeps, ownedDeps({
      kill: mockKill,
      observeCwd,
      canonicalizePath: (value: string) => value === '/foreign/workspace' ? '/foreign/canonical' : '/canonical/workspace',
    }))).rejects.toThrow(/daemon orphan 6300: indeterminate\/sigkill/);
    expect(mockKill.mock.calls.map(call => call[1])).toEqual(['TERM']);
  });

  it('continues claw stops after Motion fails', async () => {
    mockMotionStop.mockRejectedValueOnce(new Error('motion unavailable'));
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: 'alpha', isDirectory: () => true },
    ] as any);
    const stop = vi.fn().mockResolvedValue({ kind: 'stopped', pid: 123, via: 'sigterm' });
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      stop,
      findProcessesSyncForCli: mockFindProcesses,
    } as any);

    await expect(stopAllCommand(stopDeps)).rejects.toThrow(/motion failed/);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('makes a non-ENOENT claw enumeration error terminal', async () => {
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('claw enumeration EIO'), { code: 'EIO' });
    });

    await expect(stopAllCommand(stopDeps)).rejects.toThrow(/claw enumeration:.*EIO/);
  });

  it('does not write a per-claw success marker or Done for intent_recorded', async () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: 'alpha', isDirectory: () => true },
    ] as any);
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      stop: vi.fn().mockResolvedValue({ kind: 'intent_recorded' }),
      findProcessesSyncForCli: mockFindProcesses,
    } as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(stopAllCommand(stopDeps)).rejects.toThrow(/claws intent_recorded: alpha/);
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalledWith('Done.');
    } finally {
      log.mockRestore();
    }
  });

  it('does not allow Motion intent_recorded to produce Done', async () => {
    mockMotionStop.mockResolvedValueOnce({ kind: 'intent_recorded' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(stopAllCommand(stopDeps)).rejects.toThrow(/motion intent_recorded/);
      expect(log).not.toHaveBeenCalledWith('Done.');
    } finally {
      log.mockRestore();
    }
  });

  it('真实 claws/motion 与无效目录不进入普通 stop，Motion 独立停止一次且工作文件不变', async () => {
    const realFs = actualFsState.value;
    vi.mocked(fs.readdirSync).mockImplementation(realFs.readdirSync as any);
    vi.mocked(fs.statSync).mockImplementation(realFs.statSync as any);
    vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync as any);
    vi.mocked(fs.openSync).mockImplementation(realFs.openSync as any);
    vi.mocked(fs.fsyncSync).mockImplementation(realFs.fsyncSync as any);
    vi.mocked(fs.closeSync).mockImplementation(realFs.closeSync as any);
    vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync as any);
    vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync as any);
    vi.mocked(fs.existsSync).mockImplementation(realFs.existsSync as any);
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const workspace = realFs.mkdtempSync(path.join(os.tmpdir(), 'stop-ordinary-'));
    const previousRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = workspace;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sentinel = path.join(workspace, '.chestnut', 'claws', 'motion', 'clawspace', 'work', 'sentinel.txt');
      realFs.mkdirSync(path.dirname(sentinel), { recursive: true });
      realFs.writeFileSync(sentinel, 'keep me');
      realFs.mkdirSync(path.join(workspace, '.chestnut', 'claws', '.trash'), { recursive: true });
      realFs.mkdirSync(path.join(workspace, '.chestnut', 'claws', 'a..b'), { recursive: true });
      realFs.mkdirSync(path.join(workspace, '.chestnut', 'claws', 'alpha'), { recursive: true });
      const stop = vi.fn().mockResolvedValue({ kind: 'not_running' });
      vi.mocked(createProcessManagerForCLI).mockReturnValue({
        stop,
        findProcessesSyncForCli: mockFindProcesses,
      } as any);

      await expect(stopAllCommand(stopDeps, {
        audit: { write: mockAuditState.write } as any,
      })).resolves.toBeUndefined();

      expect(mockMotionStop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(String(stop.mock.calls[0][0])).toMatch(/[\\/]claws[\\/]alpha$/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reserved claw directory: motion'));
      expect(realFs.readFileSync(sentinel, 'utf8')).toBe('keep me');
    } finally {
      if (previousRoot === undefined) delete process.env.CHESTNUT_ROOT;
      else process.env.CHESTNUT_ROOT = previousRoot;
      realFs.rmSync(workspace, { recursive: true, force: true });
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
