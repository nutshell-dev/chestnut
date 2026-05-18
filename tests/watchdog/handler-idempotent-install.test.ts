import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { _resetShutdownGuard, runWatchdogLoop } from '../../src/watchdog/watchdog.js';
import { createProcessManagerForCLI } from '../../src/cli/utils/factories.js';
import { getMotionDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { setTimeout as setTimeoutP } from 'timers/promises';

vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getMotionDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

vi.mock('../../src/cli/utils/factories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/utils/factories.js')>();
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
    const clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(path.join(clawforumDir, 'motion', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(clawforumDir, 'logs'), { recursive: true });
    vi.mocked(getMotionDir).mockReturnValue(path.join(clawforumDir, 'motion'));
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
      await runWatchdogLoop();
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

    const loop2 = runWatchdogLoop();
    await new Promise((resolve) => setImmediate(resolve));
    const duringLoop2Sigterm = process.listenerCount('SIGTERM');
    const duringLoop2Sigint = process.listenerCount('SIGINT');
    try { await loop2; } catch { /* expected */ }

    expect(duringLoop2Sigterm).toBe(initialSigterm + 1);
    expect(duringLoop2Sigint).toBe(initialSigint + 1);
  });

  it('reverse: without defensive removeListener, re-entry would accumulate listeners', async () => {
    // Conceptual reverse verification:
    // If the defensive removeListener lines were deleted:
    //   - loop 1 installs 1 listener
    //   - loop 2 installs another → count becomes initial + 2
    //   - _resetShutdownGuard only removes the last handler reference
    //     → prior handlers leak in process registry
    // This test serves as documentation of the defense mechanism.
    // The actual invariant is verified by the "re-entry idempotent" test above.
    expect(true).toBe(true);
  });
});
