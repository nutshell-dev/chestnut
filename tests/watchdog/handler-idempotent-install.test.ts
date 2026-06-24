import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { _resetShutdownGuard, runWatchdogLoop } from '../../src/watchdog/watchdog.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config-load.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { setTimeout as setTimeoutP } from 'timers/promises';
const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
  };
});
vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

vi.mock('../../src/foundation/process-manager/factories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/factories.js')>();
  return {
    ...actual,
    createProcessManagerForCLI: vi.fn(),
  };
});

vi.mock('timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

describe('watchdog handler idempotent install (phase 1034 / audit-2026-05-17 NEW.P1 A.1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `wd-idem-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(path.join(chestnutDir, 'motion', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'logs'), { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({
      watchdog: { interval_ms: 100, claw_inactivity_timeout_ms: 300_000 },
      audit: { retention: { max_size_mb: null } },
    } as any);

    const mockPm = {
      getAliveStatus: vi.fn().mockReturnValue({ alive: true, reason: '' }),
      isAlive: vi.fn().mockReturnValue(false),
      spawn: vi.fn().mockResolvedValue(9999),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../../src/foundation/process-manager/index.js').ProcessManager;
    vi.mocked(createProcessManagerForCLI).mockReturnValue(mockPm);

    _resetShutdownGuard();
  });

  afterEach(() => {
    _resetShutdownGuard();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runLoopForOneTick(): Promise<void> {
    const originalSetTimeout = vi.mocked(setTimeoutP);
    originalSetTimeout.mockImplementationOnce(async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      process.emit('SIGTERM');
      exitSpy.mockRestore();
    });
    try {
      await runWatchdogLoop(fsFactory, 'logs/daemon.log');
    } catch {
      // process.exit mock may throw — expected
    }
  }

  it('single runWatchdogLoop install → SIGTERM/SIGINT listener count each === 1', async () => {
    const initialSigterm = process.listenerCount('SIGTERM');
    const initialSigint = process.listenerCount('SIGINT');

    await runLoopForOneTick();

    expect(process.listenerCount('SIGTERM')).toBe(initialSigterm + 1);
    expect(process.listenerCount('SIGINT')).toBe(initialSigint + 1);
  });

  // Reverse invariant: removeListener defense is verified by the assertion below
  // (duringLoop2Sigterm === initialSigterm + 1, not + 2).
  // phase 1217 r131 C.4: removed empty placeholder it() block (隐绿 anti-pattern)
  it('re-entry (no _resetShutdownGuard between) → listener count remains === 1 each (idempotent)', async () => {
    const initialSigterm = process.listenerCount('SIGTERM');
    const initialSigint = process.listenerCount('SIGINT');

    // Loop 1
    await runLoopForOneTick();
    expect(process.listenerCount('SIGTERM')).toBe(initialSigterm + 1);
    expect(process.listenerCount('SIGINT')).toBe(initialSigint + 1);

    // Intentionally skip _resetShutdownGuard to simulate re-entry without cleanup

    // Loop 2 — idempotent install should clean up prior handlers
    // Need to mock setTimeout so loop2 exits after SIGTERM
    const originalSetTimeout = vi.mocked(setTimeoutP);
    originalSetTimeout.mockImplementationOnce(async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      process.emit('SIGTERM');
      exitSpy.mockRestore();
    });

    const loop2 = runWatchdogLoop(fsFactory, 'logs/daemon.log');
    await new Promise((resolve) => setImmediate(resolve));
    const duringLoop2Sigterm = process.listenerCount('SIGTERM');
    const duringLoop2Sigint = process.listenerCount('SIGINT');
    try { await loop2; } catch { /* expected */ }

    expect(duringLoop2Sigterm).toBe(initialSigterm + 1);
    expect(duringLoop2Sigint).toBe(initialSigint + 1);
  });

});
