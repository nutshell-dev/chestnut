import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config/config-load.js';
import { ensureWatchdog } from '../../src/watchdog/ensure.js';
import { setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WatchdogPidForeignWorkspaceError } from '../../src/watchdog/watchdog-pid.js';

/**
 * Mock spawn race window 延 (30ms): 夸大 spawn 之间 race window.
 * Derivation: > eventloop tick / 给 ensureWatchdog 双 race 落 single spawn 路径.
 */
const SPAWN_RACE_WINDOW_MS = 30;

let spawnCount = 0;

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

vi.mock('../../src/watchdog/watchdog-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-cli.js')>();
  return {
    ...actual,
    startCommand: vi.fn().mockImplementation(async () => {
      spawnCount++;
    }),
  };
});

describe('ensureWatchdog singleton lock', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  const originalRoot = process.env.CHESTNUT_ROOT;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    _resetWatchdogContextForTest();
    tmpDir = path.join(os.tmpdir(), `wd-ensure-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);
    process.env.CHESTNUT_ROOT = '/test/root';

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');
    spawnCount = 0;
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

  it('concurrent ensureWatchdog calls spawn only one watchdog', async () => {
    const [{ startCommand: mockedStart }] = await Promise.all([
      import('../../src/watchdog/watchdog-cli.js'),
    ]);
    const mockStart = vi.mocked(mockedStart);
    mockStart.mockImplementation(async () => {
      spawnCount++;
      // Small delay to exaggerate the race window
      await new Promise(r => setTimeout(r, SPAWN_RACE_WINDOW_MS));
      const pidFile = path.join(chestnutDir, 'watchdog.pid');
      // Use current process PID so isAlive() returns true in double-check
      fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, root: '/test/root' }));
    });

    await Promise.all([ensureWatchdog(fsFactory), ensureWatchdog(fsFactory)]);

    expect(spawnCount).toBe(1);
  });

  it('stale lock recovery: second caller cleans dead lock holder + spawns', async () => {
    const lockPath = path.join(chestnutDir, 'watchdog.lock');
    // Write a lock file with a dead PID
    fs.writeFileSync(lockPath, `${999999999}\n`);

    const [{ startCommand: mockedStart }] = await Promise.all([
      import('../../src/watchdog/watchdog-cli.js'),
    ]);
    const mockStart = vi.mocked(mockedStart);
    mockStart.mockImplementation(async () => {
      spawnCount++;
      const pidFile = path.join(chestnutDir, 'watchdog.pid');
      fs.writeFileSync(pidFile, JSON.stringify({ pid: 12345, root: '/test/root' }));
    });

    await ensureWatchdog(fsFactory);

    expect(spawnCount).toBe(1);
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_STALE_RECOVERED,
      expect.stringContaining('path='),
    );
  });

  it('lock acquire timeout throws + audit ENSURE_LOCK_TIMEOUT', async () => {
    // phase 1297: use fake timers + advanceTimersByTimeAsync to fast-forward
    // through 60× 50ms retry loop instead of waiting real 3s.
    // Real fs.openSync calls still execute (each fails with EEXIST).
    vi.useFakeTimers();
    try {
      const lockPath = path.join(chestnutDir, 'watchdog.lock');
      // Write a lock file with the CURRENT process PID (alive, never releases)
      fs.writeFileSync(lockPath, `${process.pid}\n`);

      const ensurePromise = ensureWatchdog(fsFactory).catch((e: unknown) => e);

      // Advance through 60× 50ms retry loop + cross deadline (LOCK_ACQUIRE_TIMEOUT_MS=3000)
      await vi.advanceTimersByTimeAsync(3001);

      const err = await ensurePromise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Failed to acquire watchdog lock');
      expect(auditSpy).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.ENSURE_LOCK_TIMEOUT,
        // phase 698: src 加 path col
        expect.stringContaining('path='),
        expect.stringContaining('timeout_ms='),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('foreign workspace pid rethrows WatchdogPidForeignWorkspaceError', async () => {
    const pidFile = path.join(chestnutDir, 'watchdog.pid');
    const foreignAlivePid = process.pid;
    fs.writeFileSync(pidFile, JSON.stringify({ pid: foreignAlivePid, root: '/foreign/root' }));

    await expect(ensureWatchdog(fsFactory)).rejects.toThrow(WatchdogPidForeignWorkspaceError);
  });
});
