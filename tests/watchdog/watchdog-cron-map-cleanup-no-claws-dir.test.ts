/**
 * Phase 138: watchdog-cron Map cleanup 全路径覆盖（audit.P1.wd-1 真治）
 *
 * phase 1383 (P2b): inactivity maps 退场，仅测 crash 路径 cleanup：
 * 1. CLAWS_DIR 不存在 + Map 有 stale entries → cleanup 全清 + early return
 * 2. CLAWS_DIR exists + 全是 stale → 既有 cleanup 正常工作（不退化）
 * 3. CLAWS_DIR exists + 部分 stale → 部分清（不退化）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawStateAPI, clawRestartStateAPI, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { clawHasActiveContract } from '../../src/watchdog/watchdog-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
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

vi.mock('../../src/watchdog/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-utils.js')>();
  return {
    ...actual,
    clawHasActiveContract: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../../src/watchdog/workspace-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/workspace-config.js')>();
  return {
    ...actual,
    readWorkspaceWatchdogConfig: vi.fn().mockReturnValue({ interval_ms: 30_000, disk_warning_mb: 500 }),
  };
});

vi.mock('../../src/watchdog/watchdog-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-context.js')>();
  return {
    ...actual,
    getChestnutFs: vi.fn(),
    getWatchdogConfig: vi.fn(),
    getChestnutDir: vi.fn(),
  };
});

import { getChestnutFs, getWatchdogConfig, getChestnutDir } from '../../src/watchdog/watchdog-context.js';

describe('watchdog-cron Map cleanup no-claws-dir (phase 138 audit.P1.wd-1)', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(tmpdir(), `wd-cleanup-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(getChestnutDir).mockReturnValue(chestnutDir);
    vi.mocked(getWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500,
    });

    mockPm = {
      getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'test stopped' }),
      stop: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue(4242),
    } as unknown as ProcessManager;
    mockAudit = {
      write: vi.fn(),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    };

    clawStateAPI.clawPreviouslyAlive.clear();
    clawStateAPI.everSpawned.clear();
    clawStateAPI.clawPreviouslyNotified.clear();
    clawRestartStateAPI.pruneStale(new Set());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function makeMockFs(exists: boolean) {
    return {
      existsSync: vi.fn().mockImplementation((p: string) => {
        if (p === 'claws') return exists;
        return fs.existsSync(p);
      }),
      listSync: vi.fn().mockImplementation((p: string, _opts?: unknown) => {
        if (p === 'claws') {
          if (!exists) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
          const entries = fs.readdirSync(clawsDir, { withFileTypes: true });
          return entries
            .filter(e => e.isDirectory())
            .map(e => ({ name: e.name, isDirectory: true, isFile: false }));
        }
        return [];
      }),
    };
  }

  it('reverse 1: CLAWS_DIR missing → cleanup all stale Map entries', async () => {
    clawStateAPI.clawPreviouslyAlive.set('claw-C', true);
    clawStateAPI.everSpawned.add('claw-C');
    clawRestartStateAPI.set('claw-C', { status: 'retrying', consecutiveAttempts: 1, nextAttemptAt: Date.now(), awaitingStability: false });

    vi.mocked(getChestnutFs).mockReturnValue(makeMockFs(false) as any);

    await maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    expect(clawStateAPI.clawPreviouslyAlive.size).toBe(0);
    expect(clawStateAPI.everSpawned.size).toBe(0);
    expect(clawRestartStateAPI.get('claw-C')).toBeUndefined();
  });

  it('reverse 2: CLAWS_DIR exists + all stale → existing cleanup still clears all', async () => {
    fs.mkdirSync(path.join(clawsDir, 'claw-X'), { recursive: true });
    clawStateAPI.clawPreviouslyAlive.set('claw-A', true);
    clawStateAPI.everSpawned.add('claw-A');
    clawRestartStateAPI.set('claw-A', { status: 'retrying', consecutiveAttempts: 1, nextAttemptAt: Date.now(), awaitingStability: false });

    vi.mocked(getChestnutFs).mockReturnValue(makeMockFs(true) as any);

    await maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    expect(clawStateAPI.clawPreviouslyAlive.has('claw-A')).toBe(false);
    expect(clawStateAPI.everSpawned.has('claw-A')).toBe(false);
    expect(clawStateAPI.clawPreviouslyNotified.has('claw-A')).toBe(false);
    expect(clawRestartStateAPI.get('claw-A')).toBeUndefined();
  });

  it('reverse 3: CLAWS_DIR exists + partial stale → only stale removed', async () => {
    fs.mkdirSync(path.join(clawsDir, 'claw-X'), { recursive: true });
    fs.mkdirSync(path.join(clawsDir, 'claw-Y'), { recursive: true });

    clawStateAPI.clawPreviouslyAlive.set('claw-X', true);
    clawStateAPI.clawPreviouslyAlive.set('claw-Z', false);
    clawStateAPI.everSpawned.add('claw-X');
    clawStateAPI.clawPreviouslyNotified.set('claw-X', Date.now());
    clawStateAPI.clawPreviouslyNotified.set('claw-Z', Date.now() - 1000);
    clawRestartStateAPI.set('claw-X', { status: 'retrying', consecutiveAttempts: 1, nextAttemptAt: Date.now(), awaitingStability: false });
    clawRestartStateAPI.set('claw-Z', { status: 'retrying', consecutiveAttempts: 2, nextAttemptAt: Date.now(), awaitingStability: false });

    vi.mocked(getChestnutFs).mockReturnValue(makeMockFs(true) as any);

    await maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    expect(clawStateAPI.clawPreviouslyAlive.has('claw-X')).toBe(true);
    expect(clawStateAPI.clawPreviouslyAlive.has('claw-Z')).toBe(false);

    expect(clawStateAPI.everSpawned.has('claw-X')).toBe(true);

    expect(clawStateAPI.clawPreviouslyNotified.has('claw-X')).toBe(true);
    expect(clawStateAPI.clawPreviouslyNotified.has('claw-Z')).toBe(false);

    expect(clawRestartStateAPI.get('claw-X')).toBeDefined();
    expect(clawRestartStateAPI.get('claw-Z')).toBeUndefined();
  });
});
