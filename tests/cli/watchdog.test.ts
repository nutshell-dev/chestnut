/**
 * Watchdog CLI + main loop tests.
 *
 * Phase 1396 Step H: motion-facing cron paths (claw crash/inactivity/subscription)
 * retired; remaining coverage: log/audit, shutdown, state load/save, main loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeMockAudit } from '../helpers/audit.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// Phase 1235 + phase 1852 Step B: 失败协议已经 barrel 开放，改从 index.js 导入
import {
  ProcessGenerationStateError,
  ProcessSpawnConflictError,
  makeDaemonDir,
} from '../../src/foundation/process-manager/index.js';
import { FAKE_LIVE_PID, FAKE_LIVE_PID_ALT } from '../helpers/test-pids.js';

// Mock config so getChestnutDir() and getGlobalConfig() return controllable values
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
  buildLLMConfig: vi.fn(),
}));

// Phase 1289 Step C: watchdog runtime 消费自家 workspace config store
vi.mock('../../src/watchdog/workspace-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/workspace-config.js')>();
  return {
    ...actual,
    readWorkspaceWatchdogConfig: vi.fn(),
  };
});



// spawnDetached runs for real but its internal child_process.spawn is mocked (phase 106 DI hygiene)

// Mock child_process (keep for any other indirect usage)
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    // phase 1763: spawnDetached 提交点由 'spawn' 事件定义，double 自动交付 spawn 事件
    spawn: vi.fn().mockImplementation(() => makeFakeSpawnedChild(FAKE_LIVE_PID)),
    spawnSync: vi.fn(),
  };
});

// Mock timers/promises (startCommand polling / runWatchdogLoop sleep)
vi.mock('timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

// Mock factories (runWatchdogLoop uses createProcessManagerForCLI)
vi.mock('../../src/foundation/process-manager/factories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/factories.js')>();
  return {
    ...actual,
    createProcessManagerForCLI: vi.fn(),
    createDirContext: vi.fn((...args: any[]) => (actual as any).createDirContext(...args)),
  };
});

import {
  shutdownWatchdog,
  _resetShutdownGuard,
  runWatchdogLoop,
} from '../../src/watchdog/watchdog.js';
import { logWithAudit } from '../../src/watchdog/watchdog-log.js';
import {
  setAuditWriter,
  getWatchdogEntryPath,
  getChestnutFs,
  _resetWatchdogContextForTest,
  motionRestartStateAPI,
  executorRestartStateAPI,
} from '../../src/watchdog/watchdog-context.js';
import { writeWatchdogCrash, loadWatchdogState, saveWatchdogState } from '../../src/watchdog/watchdog-state.js';
import { getWatchdogPid, isWatchdogAlive } from '../../src/watchdog/watchdog-pid.js';
import { startCommand, stopCommand } from '../../src/cli/commands/watchdog-cli.js';
import { getNamedSubrootDir } from '../../src/foundation/claw-identity/index.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { spawn } from 'child_process';
import { makeFakeSpawnedChild } from '../helpers/fake-spawned-child.js';
import { setTimeout as setTimeoutP } from 'timers/promises';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { aliveLiveness, deadLiveness } from '../helpers/liveness-fixtures.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// ─── Existing: logWithAudit ──────────────────────────────────────────────────

describe('logWithAudit — A1 clearance', () => {
  let tmpDir: string;
  let auditWriter: AuditWriter;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-audit-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(path.join(chestnutDir, 'motion'), { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'logs'), { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes audit when auditType is provided and _auditWriter is set', () => {
    setAuditWriter(auditWriter);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logWithAudit(fsFactory, 'test message', WATCHDOG_AUDIT_EVENTS.CLEANUP_FAILED, 'test payload');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('test message'));

    const auditPath = path.join(tmpDir, '.chestnut', 'audit.tsv');
    const auditLines = fs.readFileSync(auditPath, 'utf-8');
    expect(auditLines).toContain('watchdog_cleanup_failed');
    expect(auditLines).toContain('test payload');

    logSpy.mockRestore();
  });

  it('only logs when auditType is omitted', () => {
    setAuditWriter(auditWriter);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logWithAudit(fsFactory, 'no audit message');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no audit message'));

    const auditPath = path.join(tmpDir, '.chestnut', 'audit.tsv');
    const auditLines = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditLines).not.toContain('no audit message');

    logSpy.mockRestore();
  });

  it('does not throw when _auditWriter is null', () => {
    setAuditWriter(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => logWithAudit(fsFactory, 'null audit message', WATCHDOG_AUDIT_EVENTS.CLEANUP_FAILED)).not.toThrow();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('null audit message'));

    logSpy.mockRestore();
  });

  it('phase 1455 Step B: log 写归位路径 watchdog/watchdog.log（不写 legacy logs/watchdog.log）', () => {
    setAuditWriter(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logWithAudit(fsFactory, 'relocated log line');

    const chestnutDir = path.join(tmpDir, '.chestnut');
    const newLog = path.join(chestnutDir, 'watchdog', 'watchdog.log');
    expect(fs.existsSync(newLog)).toBe(true);
    expect(fs.readFileSync(newLog, 'utf-8')).toContain('relocated log line');
    expect(fs.existsSync(path.join(chestnutDir, 'logs', 'watchdog.log'))).toBe(false);

    logSpy.mockRestore();
  });
});

// ─── Existing: shutdownWatchdog ──────────────────────────────────────────────

describe('shutdownWatchdog — fix 005: save state on signal', () => {
  let tmpDir: string;
  let auditWriter: AuditWriter;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    _resetShutdownGuard();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-fix5-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(path.join(chestnutDir, 'motion'), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, 'watchdog.pid'), JSON.stringify({ pid: FAKE_LIVE_PID }));
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calls saveWatchdogState before removeWatchdogPid and process.exit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    // Phase 1455 Step A: save 写目标路径 watchdog/state.json
    const stateFile = path.join(tmpDir, '.chestnut', 'watchdog', 'state.json');
    expect(fs.existsSync(stateFile)).toBe(false);

    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM')).toThrow('exit');

    expect(fs.existsSync(stateFile)).toBe(true);
    const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(savedState.schema_version).toBe(3);
    expect(savedState).not.toHaveProperty('lastInactivityNotified');
    expect(savedState).not.toHaveProperty('inactivityNotifyCount');
    expect(savedState).not.toHaveProperty('clawPreviouslyAlive');
    expect(savedState).not.toHaveProperty('everSpawned');
    expect(savedState).toHaveProperty('motionRestart');
    expect(savedState.motionRestart).toEqual({ status: 'closed', consecutiveAttempts: 0 });

    const auditLines = fs.readFileSync(path.join(tmpDir, '.chestnut', 'audit.tsv'), 'utf-8');
    expect(auditLines).toContain('watchdog_stop');

    expect(fs.existsSync(path.join(tmpDir, '.chestnut', 'watchdog.pid'))).toBe(false);

    exitSpy.mockRestore();
  });

  it('writes save_failed to audit and exits with code 1 when saveWatchdogState fails', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    // Make watchdog/state.json a directory so atomic rename fails (EISDIR) while audit remains writable
    const stateFile = path.join(tmpDir, '.chestnut', 'watchdog', 'state.json');
    fs.rmSync(stateFile, { force: true });
    fs.mkdirSync(stateFile, { recursive: true });

    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM')).toThrow('exit');

    fs.rmdirSync(stateFile);

    const auditPath = path.join(tmpDir, '.chestnut', 'audit.tsv');
    const auditLines = fs.readFileSync(auditPath, 'utf-8');
    expect(auditLines).toContain('watchdog_stop');
    expect(auditLines).toContain('save_failed=');

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it('双调 shutdownWatchdog 仅第一次真执行 (reentrant guard)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    // first call throws due to process.exit mock
    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM')).toThrow('exit');
    // second call early returns, no throw
    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGINT')).not.toThrow();

    // audit 只写了第一次的 SIGTERM
    const auditPath = path.join(tmpDir, '.chestnut', 'audit.tsv');
    const auditLines = fs.readFileSync(auditPath, 'utf-8');
    expect(auditLines).toContain('watchdog_stop');
    expect(auditLines).toContain('signal=SIGTERM');

    exitSpy.mockRestore();
  });
});

// ─── Step 2: getWatchdogPid / isWatchdogAlive / getWatchdogEntryPath ─────────

describe('getWatchdogPid', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-pid-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns pid when pid file exists with valid content', () => {
    const pidFile = path.join(tmpDir, '.chestnut', 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root: '/some/root' }));
    expect(getWatchdogPid(fsFactory)).toBe(FAKE_LIVE_PID_ALT);
  });

  it('returns null when pid file does not exist', () => {
    expect(getWatchdogPid(fsFactory)).toBeNull();
  });
});

describe('isWatchdogAlive', () => {
  let tmpDir: string;
  const originalRoot = process.env.CHESTNUT_ROOT;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-alive-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    process.env.CHESTNUT_ROOT = '/test/root';
  });

  afterEach(() => {
    if (originalRoot !== undefined) {
      process.env.CHESTNUT_ROOT = originalRoot;
    } else {
      delete process.env.CHESTNUT_ROOT;
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when pid file exists, root matches, and process is alive', () => {
    const pidFile = path.join(tmpDir, '.chestnut', 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root: '/test/root' }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(isWatchdogAlive(fsFactory)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(FAKE_LIVE_PID_ALT, 0);
  });

  it('returns false and removes pid file when root does not match', () => {
    const pidFile = path.join(tmpDir, '.chestnut', 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root: '/different/root' }));
    expect(isWatchdogAlive(fsFactory)).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('returns false when pid file does not exist', () => {
    expect(isWatchdogAlive(fsFactory)).toBe(false);
  });
});

describe('getWatchdogEntryPath', () => {
  it('returns a path ending with watchdog-entry.js', () => {
    const result = getWatchdogEntryPath();
    expect(result).toMatch(/watchdog-entry\.js$/);
  });

  it('returns a string (path is resolvable)', () => {
    const result = getWatchdogEntryPath();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Step 3: startCommand / stopCommand ──────────────────────────────────────

describe('startCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-start-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(spawn).mockImplementation(() => makeFakeSpawnedChild(FAKE_LIVE_PID) as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs "already running" if watchdog is alive before spawn', async () => {
    const pidFile = path.join(tmpDir, '.chestnut', 'watchdog.pid');
    const root = process.env.CHESTNUT_ROOT ?? process.cwd();
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root }));
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await startCommand(fsFactory);

    expect(spawn).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('spawns watchdog process when not alive (throws CliError because PID never appears in test)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // phase 324 H2: startCommand 现在在 PID 未写时 throw CliError 而非静默 exit 0。
    // 本测试环境 spawn 被 mock、不会真写 PID → 必 throw。
    await expect(startCommand(fsFactory)).rejects.toThrow(/Watchdog failed to start/);

    expect(spawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('watchdog-entry')]),
      expect.objectContaining({ detached: true, env: expect.any(Object) }),
    );
    logSpy.mockRestore();
  });

  it('phase 324 H2: throws CliError if pid file not written after 30 polls', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(startCommand(fsFactory)).rejects.toThrow(/Watchdog failed to start within/);
    logSpy.mockRestore();
  });
});

describe('stopCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-stop-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs "not running" and removes pid file if watchdog is not alive', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await stopCommand(fsFactory);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    logSpy.mockRestore();
  });

  it('sends SIGTERM to running watchdog', async () => {
    const chestnutDir = path.join(tmpDir, '.chestnut');
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    const root = process.env.CHESTNUT_ROOT ?? process.cwd();
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root }));

    const killSpy = vi.spyOn(process, 'kill')
      .mockImplementationOnce(() => true)   // first call: kill(pid, 0) → alive check
      .mockImplementationOnce(() => true)   // second call: kill(pid, 'SIGTERM')
      .mockImplementation(() => { throw new Error('ESRCH'); }); // subsequent 0-checks → dead

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await stopCommand(fsFactory);

    expect(killSpy).toHaveBeenCalledWith(FAKE_LIVE_PID_ALT, 'SIGTERM');
    logSpy.mockRestore();
  });

  it('reports failure if SIGTERM send throws', async () => {
    const chestnutDir = path.join(tmpDir, '.chestnut');
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    const root = process.env.CHESTNUT_ROOT ?? process.cwd();
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root }));

    vi.spyOn(process, 'kill')
      .mockImplementationOnce(() => true)           // isWatchdogAlive kill(0)
      .mockImplementationOnce(() => { throw new Error('EPERM'); });  // SIGTERM fails

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await stopCommand(fsFactory);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send SIGTERM'), expect.anything());
    logSpy.mockRestore();
  });
});

// ─── Step 4: runWatchdogLoop ─────────────────────────────────────────────────

describe('runWatchdogLoop', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let mockPm: ProcessManager;
  let capturedHandlers: Record<string, Function>;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-loop-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(path.join(chestnutDir, 'motion', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'logs'), { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 5_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });

    mockPm = {
      // phase 1773: tick 同时走 liveness(motion) + isAlive(per claw)
      liveness: vi.fn().mockReturnValue(aliveLiveness()),
      isAlive: vi.fn().mockReturnValue(false),
      spawn: vi.fn().mockResolvedValue(9999),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProcessManager;
    vi.mocked(createProcessManagerForCLI).mockReturnValue(mockPm);

    capturedHandlers = {};
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
      capturedHandlers[event] = handler;
      return process;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runLoopForOneTick(): Promise<void> {
    const originalSetTimeout = vi.mocked(setTimeoutP);
    originalSetTimeout.mockImplementationOnce(async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      if (capturedHandlers['SIGTERM']) {
        try { capturedHandlers['SIGTERM'](); } catch { /* exit mock throws */ }
      }
      exitSpy.mockRestore();
    });
    try {
      await runWatchdogLoop(fsFactory);
    } catch {
      // process.exit mock may throw — expected
    }
  }

  it('writes watchdog_start audit on startup', async () => {
    await runLoopForOneTick();

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('watchdog_start');
  });

  it('writes watchdog_check to tick.tsv each tick (phase 1318 Step B)', async () => {
    await runLoopForOneTick();

    const tickPath = path.join(chestnutDir, 'audit', 'tick.tsv'); // phase 1318: 心跳 → tick.tsv
    const tickContent = fs.existsSync(tickPath) ? fs.readFileSync(tickPath, 'utf-8') : '';
    expect(tickContent).toContain('watchdog_check');
    expect(tickContent).toContain('present=');

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv');
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).not.toContain('watchdog_check');
  });

  it('writes watchdog_restart_triggered when motion is down', async () => {
    vi.mocked(mockPm.liveness).mockReturnValue(deadLiveness());
    vi.mocked(mockPm.stop).mockResolvedValue(undefined);

    await runLoopForOneTick();

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('watchdog_restart_triggered');
    expect(auditContent).toContain('process_spawned');
  });

  it('writes process_spawn_failed when restart fails', async () => {
    vi.mocked(mockPm.liveness).mockReturnValue(deadLiveness());
    vi.mocked(mockPm.stop).mockResolvedValue(undefined);
    vi.mocked(mockPm.spawn).mockRejectedValue(new Error('spawn error'));

    await runLoopForOneTick();

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('process_spawn_failed');
  });

  it('normal tick: motion alive → no restart audit events', async () => {
    vi.mocked(mockPm.liveness).mockReturnValue(aliveLiveness());

    await runLoopForOneTick();

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).not.toContain('watchdog_restart_triggered');
    expect(auditContent).not.toContain('process_spawn_failed');
  });

  it('phase 1164: spawn success awaits stability; next tick down accumulates attempts', async () => {
    vi.mocked(mockPm.liveness).mockReturnValue(deadLiveness());
    vi.mocked(mockPm.stop).mockResolvedValue(undefined);
    vi.mocked(mockPm.spawn).mockResolvedValue(9999);

    await runLoopForOneTick();

    // After one tick with spawn success, state should be retrying attempts=1 awaitingStability=true
    expect(motionRestartStateAPI.snapshot()).toEqual({
      status: 'retrying',
      consecutiveAttempts: 1,
      nextAttemptAt: expect.any(Number),
      awaitingStability: true,
    });

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContentAfterFirst = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContentAfterFirst).toContain('process_spawned');
    expect(auditContentAfterFirst).not.toContain('watchdog_motion_stability_confirmed');
  });

  it('phase 1164: failed spawn accumulates attempt count without resetting', async () => {
    vi.mocked(mockPm.liveness).mockReturnValue(deadLiveness());
    vi.mocked(mockPm.stop).mockResolvedValue(undefined);
    vi.mocked(mockPm.spawn).mockRejectedValue(new Error('spawn error'));

    await runLoopForOneTick();

    expect(motionRestartStateAPI.snapshot()).toEqual({
      status: 'retrying',
      consecutiveAttempts: 1,
      nextAttemptAt: expect.any(Number),
      awaitingStability: false,
    });
  });

  it('phase 1235: ProcessGenerationStateError 走 failed/backoff + PROCESS_SPAWN_FAILED（不穿 catch 误分类）', async () => {
    vi.mocked(mockPm.liveness).mockReturnValue(deadLiveness());
    vi.mocked(mockPm.stop).mockResolvedValue(undefined);
    vi.mocked(mockPm.spawn).mockRejectedValue(
      new ProcessGenerationStateError(makeDaemonDir('motion'), 'spawning', 'inspect', new Error('malformed')),
    );

    await runLoopForOneTick();

    // malformed generation state 不得清零 backoff：attempts +1
    expect(motionRestartStateAPI.snapshot()).toEqual({
      status: 'retrying',
      consecutiveAttempts: 1,
      nextAttemptAt: expect.any(Number),
      awaitingStability: false,
    });

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('process_spawn_failed');
  });

  it('phase 1235: ProcessSpawnConflictError 才清零 backoff（另一实例是合法 winner）', async () => {
    vi.mocked(mockPm.liveness).mockReturnValue(deadLiveness());
    vi.mocked(mockPm.stop).mockResolvedValue(undefined);
    vi.mocked(mockPm.spawn).mockRejectedValue(
      new ProcessSpawnConflictError(makeDaemonDir('motion'), 'spawn_in_progress', 'gen-winner'),
    );

    await runLoopForOneTick();

    expect(motionRestartStateAPI.snapshot()).toEqual({ status: 'closed', consecutiveAttempts: 0 });

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).not.toContain('process_spawn_failed');
  });

  it('phase 1164: hitting max attempts transitions to open circuit', async () => {
    motionRestartStateAPI.replace({
      status: 'retrying',
      consecutiveAttempts: 10,
      nextAttemptAt: 0,
      awaitingStability: false,
    });

    vi.mocked(mockPm.liveness).mockReturnValue(deadLiveness());

    await runLoopForOneTick();

    expect(motionRestartStateAPI.snapshot()).toEqual({
      status: 'open',
      consecutiveAttempts: 10,
      openedAt: expect.any(Number),
    });

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('watchdog_gave_up');
    expect(auditContent).toContain('reason=motion_restart_unstable');
    expect(auditContent).toContain('consecutive_failures=10');
  });

  it('phase 1164: motion alive after retrying emits stability confirmed', async () => {
    // Seed state as retrying awaitingStability
    motionRestartStateAPI.replace({
      status: 'retrying',
      consecutiveAttempts: 2,
      nextAttemptAt: 5_000,
      awaitingStability: true,
    });

    vi.mocked(mockPm.liveness).mockReturnValue(aliveLiveness());

    await runLoopForOneTick();

    expect(motionRestartStateAPI.snapshot()).toEqual({
      status: 'closed',
      consecutiveAttempts: 0,
    });

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('watchdog_motion_stability_confirmed');
    expect(auditContent).toContain('previous_attempts=2');
  });

  it('phase 1164: open state + alive recovery emits circuit_reopened', async () => {
    motionRestartStateAPI.replace({
      status: 'open',
      consecutiveAttempts: 10,
      openedAt: 1_000,
    });

    vi.mocked(mockPm.liveness).mockReturnValue(aliveLiveness());

    await runLoopForOneTick();

    expect(motionRestartStateAPI.snapshot()).toEqual({
      status: 'closed',
      consecutiveAttempts: 0,
    });

    const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv'); // Phase 1288 Step C: 生产 writer 写 audit/audit.tsv
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('watchdog_circuit_reopened');
    expect(auditContent).toContain('prev_failures=10');
  });

  // H3 crash audit tests (from phase269, merged with phase271)
});

describe('writeWatchdogCrash', () => {
  it('writes WATCHDOG_CRASH audit when _auditWriter is set', () => {
    const mockAudit = makeMockAudit();
    setAuditWriter(mockAudit as any);

    writeWatchdogCrash(new Error('test crash'));

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CRASH,
      expect.stringContaining('test crash'),
    );

    setAuditWriter(null);  // cleanup
  });

  it('does not throw when _auditWriter is null', () => {
    setAuditWriter(null);
    expect(() => writeWatchdogCrash(new Error('no writer'))).not.toThrow();
  });
});

// ─── Phase 272: loadWatchdogState / saveWatchdogState ────────────────────────

describe('loadWatchdogState / saveWatchdogState — A2+A3+A4', () => {
  let tmpDir: string;
  let chestnutDir: string;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-state-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('legacy state without schema_version is schema invalid', () => {
    const stateFile = path.join(chestnutDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      lastInactivityNotified: { 'claw-1': 1000 },
      inactivityNotifyCount:  { 'claw-1': 2 },
    }));

    const mockAudit = makeMockAudit() as unknown as AuditWriter;
    setAuditWriter(mockAudit);

    expect(() => loadWatchdogState(fsFactory)).not.toThrow();
    const schemaCall = mockAudit.write.mock.calls.find((c) => c[0] === WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID);
    expect(schemaCall).toBeDefined();
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('writes WATCHDOG_STATE_LOAD_FAILED audit and renames corrupt file', () => {
    const stateFile = path.join(chestnutDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, 'NOT_VALID_JSON{{{{');

    const mockAudit = makeMockAudit() as unknown as AuditWriter;
    setAuditWriter(mockAudit);

    loadWatchdogState(fsFactory);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
      expect.stringContaining('backup='),
      'move_ok=true',
      expect.stringContaining('error='),
    );
    expect(fs.existsSync(stateFile)).toBe(false);
    const files = fs.readdirSync(chestnutDir);
    expect(files.some(f => f.includes('.corrupt-'))).toBe(true);
  });

  it('loadWatchdogState resets durable state on corrupt JSON (no partial leak)', () => {
    const stateFile = path.join(chestnutDir, 'watchdog-state.json');

    // Seed stale durable state
    motionRestartStateAPI.replace({ status: 'retrying', consecutiveAttempts: 5, nextAttemptAt: 9999, awaitingStability: false });
    executorRestartStateAPI.replace({ claw1: { status: 'open', consecutiveAttempts: 1, openedAt: 1000 } });

    // 写真正 corrupt 的 JSON
    fs.writeFileSync(stateFile, '{ not valid json');

    const mockAudit = makeMockAudit() as unknown as AuditWriter;
    setAuditWriter(mockAudit);

    loadWatchdogState(fsFactory);

    // corrupt 路径 catch 内应清空 durable state，防止 partial populate 泄漏
    expect(motionRestartStateAPI.snapshot()).toEqual({ status: 'closed', consecutiveAttempts: 0 });
    expect(executorRestartStateAPI.snapshot()).toEqual({});
  });

  it('loadWatchdogState audits move failure separately', () => {
    const stateFile = path.join(chestnutDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, 'NOT_VALID_JSON{{{{');

    // 让 moveSync 抛错（spyOn getChestnutFs 返回的实例）
    const chestnutFs = getChestnutFs(fsFactory);
    const moveSpy = vi.spyOn(chestnutFs, 'moveSync').mockImplementation(() => {
      throw new Error('mock move failure');
    });

    const mockAudit = makeMockAudit() as unknown as AuditWriter;
    setAuditWriter(mockAudit);

    loadWatchdogState(fsFactory);

    moveSpy.mockRestore();

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
      expect.stringContaining('backup='),
      'move_ok=false',
      expect.stringContaining('move_error=mock move failure'),
      expect.stringContaining('error='),
    );
  });

  it('saveWatchdogState uses atomic write (new inode)', () => {
    // Phase 1455 Step A: 写路径 = watchdog/state.json
    const stateFile = path.join(chestnutDir, 'watchdog', 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ old: true }));
    const oldStat = fs.statSync(stateFile);

    saveWatchdogState(fsFactory);

    const newStat = fs.statSync(stateFile);
    // Atomic write via rename creates a new inode (POSIX)
    expect(newStat.ino).not.toBe(oldStat.ino);
  });
});
