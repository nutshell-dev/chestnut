/**
 * watchdog tests — fix 4: per-claw try-catch in maybeCronClawInactivity
 *
 * When one claw's check throws, the loop should continue and check remaining claws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeMockAudit } from '../helpers/audit.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { FAKE_LIVE_PID, FAKE_LIVE_PID_ALT } from '../helpers/test-pids.js';

// Mock config so getClawforumDir() and getGlobalConfig() return controllable values
vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

// Mock watchdog-utils so we can control clawHasContract
vi.mock('../../src/watchdog/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-utils.js')>();
  return {
    ...actual,
    clawHasContract: vi.fn(),
    getClawActivityInfo: vi.fn(),
    gatherClawSnapshot: vi.fn(),
    shouldResetNotifyCount: vi.fn().mockReturnValue(false),
    getEffectiveInterval: vi.fn().mockReturnValue(999_999_999),
  };
});

// Mock spawnDetached (startCommand uses spawnDetached from L1 ProcessExec)
vi.mock('../../src/foundation/process-exec/spawn-detached.js', () => ({
  spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
}));

// Mock child_process (keep for any other indirect usage)
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
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
  maybeCronClawInactivity,
  shutdownWatchdog,
  _resetShutdownGuard,
  logWithAudit,
  setAuditWriter,
  maybeCronClawCrash,
  writeWatchdogCrash,
  getWatchdogPid,
  isWatchdogAlive,
  getWatchdogEntryPath,
  runWatchdogLoop,
  startCommand,
  stopCommand,
  loadWatchdogState,
  saveWatchdogState,
} from '../../src/watchdog/watchdog.js';
import { getNamedSubrootDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { clawHasContract, gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { lastInactivityNotified, inactivityNotifyCount, getClawforumFs } from '../../src/watchdog/watchdog-context.js';
import { InboxWriter } from '../../src/foundation/messaging/index.js';
import { spawnDetached } from '../../src/foundation/process-exec/spawn-detached.js';
import { setTimeout as setTimeoutP } from 'timers/promises';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// ─── Step 1: fix-4 existing tests (N1 audit parameter fix) ───────────────────

describe('maybeCronClawInactivity — fix 4: per-claw error isolation', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: AuditWriter;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wdfix4-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    clawsDir = path.join(clawforumDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });

    fs.mkdirSync(path.join(clawsDir, 'claw-a'), { recursive: true });
    fs.mkdirSync(path.join(clawsDir, 'claw-b'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);

    mockPm = { isAlive: vi.fn().mockReturnValue(false) } as unknown as ProcessManager;
    mockAudit = makeMockAudit() as unknown as AuditWriter;
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('continues checking claw-b even when claw-a check throws', async () => {
    vi.mocked(clawHasContract)
      .mockImplementationOnce(() => { throw new Error('stat error'); })
      .mockReturnValueOnce(false);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(maybeCronClawInactivity(mockPm, mockAudit, fsFactory)).resolves.not.toThrow();

    expect(clawHasContract).toHaveBeenCalledTimes(2);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking claw'),
    );

    logSpy.mockRestore();
  });

  it('does not throw even if all claws error', async () => {
    vi.mocked(clawHasContract).mockImplementation(() => {
      throw new Error('all fail');
    });

    await expect(maybeCronClawInactivity(mockPm, mockAudit, fsFactory)).resolves.not.toThrow();
    expect(clawHasContract).toHaveBeenCalledTimes(2);
  });

  it('emits watchdog_claw_scan with ctx=inactivity after scanning claws dir', async () => {
    const calls = vi.mocked(mockAudit.write).mock.calls;
    // Clear any calls from previous tests in this describe block
    calls.length = 0;

    await maybeCronClawInactivity(mockPm, mockAudit, fsFactory);

    const scanCall = calls.find(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAW_SCAN);
    expect(scanCall).toBeDefined();
    expect(scanCall![1]).toContain('ctx=inactivity');
    expect(scanCall![1]).toContain('claw-a');
    expect(scanCall![1]).toContain('claw-b');
  });
});

// ─── Existing: logWithAudit ──────────────────────────────────────────────────

describe('logWithAudit — A1 clearance', () => {
  let tmpDir: string;
  let auditWriter: AuditWriter;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-audit-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(path.join(clawforumDir, 'motion'), { recursive: true });
    fs.mkdirSync(path.join(clawforumDir, 'logs'), { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: clawforumDir }),
      'audit.tsv',
      null,
    );
  });

  afterEach(() => {
    setAuditWriter(null);
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes audit when auditType is provided and _auditWriter is set', () => {
    setAuditWriter(auditWriter);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logWithAudit(fsFactory, 'test message', WATCHDOG_AUDIT_EVENTS.CLEANUP_FAILED, 'test payload');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('test message'));

    const auditPath = path.join(tmpDir, '.clawforum', 'audit.tsv');
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

    const auditPath = path.join(tmpDir, '.clawforum', 'audit.tsv');
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
});

// ─── Existing: shutdownWatchdog ──────────────────────────────────────────────

describe('shutdownWatchdog — fix 005: save state on signal', () => {
  let tmpDir: string;
  let auditWriter: AuditWriter;

  beforeEach(() => {
    _resetShutdownGuard();
    tmpDir = path.join(os.tmpdir(), `wd-fix5-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(path.join(clawforumDir, 'motion'), { recursive: true });
    fs.writeFileSync(path.join(clawforumDir, 'watchdog.pid'), JSON.stringify({ pid: FAKE_LIVE_PID }));
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: clawforumDir }),
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

    const stateFile = path.join(tmpDir, '.clawforum', 'watchdog-state.json');
    expect(fs.existsSync(stateFile)).toBe(false);

    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM')).toThrow('exit');

    expect(fs.existsSync(stateFile)).toBe(true);
    const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(savedState).toHaveProperty('lastInactivityNotified');
    expect(savedState).toHaveProperty('inactivityNotifyCount');

    const auditLines = fs.readFileSync(path.join(tmpDir, '.clawforum', 'audit.tsv'), 'utf-8');
    expect(auditLines).toContain('watchdog_stop');

    expect(fs.existsSync(path.join(tmpDir, '.clawforum', 'watchdog.pid'))).toBe(false);

    exitSpy.mockRestore();
  });

  it('writes save_failed to audit and exits with code 1 when saveWatchdogState fails', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    // Make watchdog-state.json a directory so atomic rename fails (EISDIR) while audit remains writable
    const stateFile = path.join(tmpDir, '.clawforum', 'watchdog-state.json');
    fs.rmSync(stateFile, { force: true });
    fs.mkdirSync(stateFile);

    expect(() => shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM')).toThrow('exit');

    fs.rmdirSync(stateFile);

    const auditPath = path.join(tmpDir, '.clawforum', 'audit.tsv');
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
    const auditPath = path.join(tmpDir, '.clawforum', 'audit.tsv');
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
    tmpDir = path.join(os.tmpdir(), `wd-pid-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns pid when pid file exists with valid content', () => {
    const pidFile = path.join(tmpDir, '.clawforum', 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root: '/some/root' }));
    expect(getWatchdogPid(fsFactory)).toBe(FAKE_LIVE_PID_ALT);
  });

  it('returns null when pid file does not exist', () => {
    expect(getWatchdogPid(fsFactory)).toBeNull();
  });
});

describe('isWatchdogAlive', () => {
  let tmpDir: string;
  const originalRoot = process.env.CLAWFORUM_ROOT;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-alive-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    process.env.CLAWFORUM_ROOT = '/test/root';
  });

  afterEach(() => {
    if (originalRoot !== undefined) {
      process.env.CLAWFORUM_ROOT = originalRoot;
    } else {
      delete process.env.CLAWFORUM_ROOT;
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when pid file exists, root matches, and process is alive', () => {
    const pidFile = path.join(tmpDir, '.clawforum', 'watchdog.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root: '/test/root' }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(isWatchdogAlive(fsFactory)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(FAKE_LIVE_PID_ALT, 0);
  });

  it('returns false and removes pid file when root does not match', () => {
    const pidFile = path.join(tmpDir, '.clawforum', 'watchdog.pid');
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
    const result = getWatchdogEntryPath(fsFactory);
    expect(result).toMatch(/watchdog-entry\.js$/);
  });

  it('returns a string (path is resolvable)', () => {
    const result = getWatchdogEntryPath(fsFactory);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Step 3: startCommand / stopCommand ──────────────────────────────────────

describe('startCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-start-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(spawnDetached).mockReturnValue({ pid: FAKE_LIVE_PID });
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs "already running" if watchdog is alive before spawn', async () => {
    const pidFile = path.join(tmpDir, '.clawforum', 'watchdog.pid');
    const root = process.env.CLAWFORUM_ROOT ?? process.cwd();
    fs.writeFileSync(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID_ALT, root }));
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await startCommand(fsFactory);

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('spawns watchdog process when not alive', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await startCommand(fsFactory);

    expect(spawnDetached).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('watchdog-entry')]),
      expect.objectContaining({ env: expect.any(Object) }),
    );
    logSpy.mockRestore();
  });

  it('reports start failure if pid file not written after 30 polls', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await startCommand(fsFactory);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('may have failed'));
    logSpy.mockRestore();
  });
});

describe('stopCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-stop-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
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
    const clawforumDir = path.join(tmpDir, '.clawforum');
    const pidFile = path.join(clawforumDir, 'watchdog.pid');
    const root = process.env.CLAWFORUM_ROOT ?? process.cwd();
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
    const clawforumDir = path.join(tmpDir, '.clawforum');
    const pidFile = path.join(clawforumDir, 'watchdog.pid');
    const root = process.env.CLAWFORUM_ROOT ?? process.cwd();
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
  let clawforumDir: string;
  let mockPm: ProcessManager;
  let capturedHandlers: Record<string, Function>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-loop-${randomUUID()}`);
    clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(path.join(clawforumDir, 'motion', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(clawforumDir, 'logs'), { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({
      watchdog: { interval_ms: 100, claw_inactivity_timeout_ms: 300_000 },
      audit: { retention: { max_size_mb: null } },
    } as any);

    mockPm = {
      getAliveStatus: vi.fn().mockReturnValue({ alive: true, reason: '' }),
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
    setAuditWriter(null);
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

    const auditPath = path.join(clawforumDir, 'audit.tsv');
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('watchdog_start');
  });

  it('writes watchdog_check audit each tick', async () => {
    await runLoopForOneTick();

    const auditPath = path.join(clawforumDir, 'audit.tsv');
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('watchdog_check');
    expect(auditContent).toContain('present=');
  });

  it('writes watchdog_restart_triggered when motion is down', async () => {
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'no_pid' });
    vi.mocked(mockPm.stop).mockResolvedValue(undefined);

    await runLoopForOneTick();

    const auditPath = path.join(clawforumDir, 'audit.tsv');
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('watchdog_restart_triggered');
    expect(auditContent).toContain('process_spawn');
  });

  it('writes process_spawn_failed when restart fails', async () => {
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'no_pid' });
    vi.mocked(mockPm.stop).mockResolvedValue(undefined);
    vi.mocked(mockPm.spawn).mockRejectedValue(new Error('spawn error'));

    await runLoopForOneTick();

    const auditPath = path.join(clawforumDir, 'audit.tsv');
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).toContain('process_spawn_failed');
  });

  it('normal tick: motion alive → no restart audit events', async () => {
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: '' });

    await runLoopForOneTick();

    const auditPath = path.join(clawforumDir, 'audit.tsv');
    const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
    expect(auditContent).not.toContain('watchdog_restart_triggered');
    expect(auditContent).not.toContain('process_spawn_failed');
  });

  // H3 crash audit tests (from phase269, merged with phase271)
});

describe('maybeCronClawCrash — crash audit', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: { write: ReturnType<typeof vi.fn>; flush?: () => void };
  let writeSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wdcrash-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    clawsDir = path.join(clawforumDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });
    fs.mkdirSync(path.join(clawforumDir, 'motion', 'inbox', 'pending'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(clawHasContract).mockReturnValue(true);
    vi.mocked(gatherClawSnapshot).mockReturnValue({
      contract: 'c1', outboxPending: 0, inboxPending: 0, status: 'alive',
    } as any);

    mockPm = { isAlive: vi.fn(), getAliveStatus: vi.fn() } as unknown as ProcessManager;
    mockAudit = makeMockAudit();

    writeSyncSpy = vi.spyOn(InboxWriter.prototype, 'writeSync').mockImplementation(() => {});
  });

  afterEach(() => {
    writeSyncSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits CLAW_CRASH_DETECTED when claw transitions alive→dead with contract', () => {
    const clawId = `claw-crash-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // First call: alive=true (establish baseline)
    vi.mocked(mockPm.isAlive).mockReturnValue(true);
    maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    // Second call: alive=false (crash detected)
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
      expect.stringContaining(clawId),
      'has_contract=true',
      'detected_by=previous_tick',
    );
  });

  it('emits watchdog_claw_scan with ctx=crash after scanning claws dir', () => {
    const clawId = `claw-scan-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // Ensure isAlive returns false so crash detection path is not triggered
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    // Clear previous calls to isolate this test
    vi.mocked(mockAudit.write).mockClear();

    maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    const calls = vi.mocked(mockAudit.write).mock.calls;
    const scanCall = calls.find(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAW_SCAN);
    expect(scanCall).toBeDefined();
    expect(scanCall![1]).toContain('ctx=crash');
    expect(scanCall![1]).toContain(clawId);
  });
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
  let clawforumDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-state-${randomUUID()}`);
    clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);
  });

  afterEach(() => {
    setAuditWriter(null);
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads legacy state without version field', () => {
    const stateFile = path.join(clawforumDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      lastInactivityNotified: { 'claw-1': 1000 },
      inactivityNotifyCount:  { 'claw-1': 2 },
    }));

    const mockAudit = makeMockAudit() as unknown as AuditWriter;
    setAuditWriter(mockAudit);

    expect(() => loadWatchdogState(fsFactory)).not.toThrow();
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
      expect.any(String),
    );
  });

  it('writes WATCHDOG_STATE_LOAD_FAILED audit and renames corrupt file', () => {
    const stateFile = path.join(clawforumDir, 'watchdog-state.json');
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
    const files = fs.readdirSync(clawforumDir);
    expect(files.some(f => f.includes('.corrupt-'))).toBe(true);
  });

  it('loadWatchdogState clears Maps on corrupt JSON (no partial leak)', () => {
    const stateFile = path.join(clawforumDir, 'watchdog-state.json');

    // 先 populate Maps with stale data
    lastInactivityNotified.set('stale-claw', 12345);
    inactivityNotifyCount.set('stale-claw', 7);

    // 写真正 corrupt 的 JSON
    fs.writeFileSync(stateFile, '{ not valid json');

    const mockAudit = makeMockAudit() as unknown as AuditWriter;
    setAuditWriter(mockAudit);

    loadWatchdogState(fsFactory);

    // corrupt 路径 catch 内应清空 Maps，防止 partial populate 泄漏
    expect(lastInactivityNotified.size).toBe(0);
    expect(inactivityNotifyCount.size).toBe(0);
  });

  it('loadWatchdogState audits move failure separately', () => {
    const stateFile = path.join(clawforumDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, 'NOT_VALID_JSON{{{{');

    // 让 moveSync 抛错（spyOn getClawforumFs 返回的实例）
    const clawforumFs = getClawforumFs(fsFactory);
    const moveSpy = vi.spyOn(clawforumFs, 'moveSync').mockImplementation(() => {
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
    const stateFile = path.join(clawforumDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ old: true }));
    const oldStat = fs.statSync(stateFile);

    saveWatchdogState(fsFactory);

    const newStat = fs.statSync(stateFile);
    // Atomic write via rename creates a new inode (POSIX)
    expect(newStat.ino).not.toBe(oldStat.ino);
  });
});
