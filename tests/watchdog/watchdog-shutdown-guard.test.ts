import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { _resetShutdownGuard, runWatchdogLoop } from '../../src/watchdog/watchdog.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config/config-load.js';
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

describe('watchdog signal handler lifecycle (phase 994 A.1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `wd-sig-${randomUUID()}`);
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

  it('runWatchdogLoop + _resetShutdownGuard does not accumulate listeners', async () => {
    const initialSigterm = process.listenerCount('SIGTERM');
    const initialSigint = process.listenerCount('SIGINT');

    await runLoopForOneTick();
    expect(process.listenerCount('SIGTERM')).toBe(initialSigterm + 1);
    expect(process.listenerCount('SIGINT')).toBe(initialSigint + 1);

    _resetShutdownGuard();
    expect(process.listenerCount('SIGTERM')).toBe(initialSigterm);
    expect(process.listenerCount('SIGINT')).toBe(initialSigint);

    await runLoopForOneTick();
    expect(process.listenerCount('SIGTERM')).toBe(initialSigterm + 1);
    expect(process.listenerCount('SIGINT')).toBe(initialSigint + 1);

    _resetShutdownGuard();
    expect(process.listenerCount('SIGTERM')).toBe(initialSigterm);
    expect(process.listenerCount('SIGINT')).toBe(initialSigint);
  });
});
