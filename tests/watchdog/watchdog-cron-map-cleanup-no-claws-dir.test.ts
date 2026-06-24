/**
 * Phase 138: watchdog-cron Map cleanup 全路径覆盖（audit.P1.wd-1 真治）
 *
 * 反向测试：
 * 1. CLAWS_DIR 不存在 + Map 有 stale entries → cleanup 全清 + early return
 * 2. CLAWS_DIR exists + 全是 stale → 既有 cleanup 正常工作（不退化）
 * 3. CLAWS_DIR exists + 部分 stale → 部分清（不退化）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawInactivity, maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawStateAPI, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config-load.js';
import { clawHasContract, gatherClawSnapshot, clawHasActiveContract } from '../../src/watchdog/watchdog-utils.js';
import { notifyClaw } from '../../src/foundation/messaging/index.js';
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

vi.mock('../../src/watchdog/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-utils.js')>();
  return {
    ...actual,
    clawHasContract: vi.fn(),
    clawHasActiveContract: vi.fn().mockReturnValue(false),
    gatherClawSnapshot: vi.fn(),
  };
});

vi.mock('../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/messaging/index.js')>();
  return {
    ...actual,
    notifyClaw: vi.fn(),
  };
});

vi.mock('../../src/watchdog/watchdog-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-context.js')>();
  return {
    ...actual,
    getChestnutFs: vi.fn(),
    getGlobalConfig: vi.fn(),
    getChestnutDir: vi.fn(),
  };
});

import { getChestnutFs, getGlobalConfig, getChestnutDir } from '../../src/watchdog/watchdog-context.js';

describe('watchdog-cron Map cleanup no-claws-dir (phase 138 audit.P1.wd-1)', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    _resetWatchdogContextForTest();
    tmpDir = path.join(tmpdir(), `wd-cleanup-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(clawHasContract).mockReturnValue(true);
    vi.mocked(gatherClawSnapshot).mockReturnValue({
      contract: 'active:c1', outboxPending: 0, inboxPending: 0, status: 'stopped',
    } as any);
    vi.mocked(getChestnutDir).mockReturnValue(chestnutDir);
    vi.mocked(getGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);

    mockPm = { isAlive: vi.fn() } as unknown as ProcessManager;
    mockAudit = {
      write: vi.fn(),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    };

    // Reset all Maps
    clawStateAPI.lastInactivityNotified.clear();
    clawStateAPI.inactivityNotifyCount.clear();
    clawStateAPI.clawPreviouslyAlive.clear();
    clawStateAPI.everSpawned.clear();
    clawStateAPI.clawPreviouslyNotified.clear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // Helper to build a mock fs that reports CLAWS_DIR exists or not
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
    // setup: clawStateAPI 多 Map 加 stale entries
    clawStateAPI.lastInactivityNotified.set('claw-A', 100);
    clawStateAPI.lastInactivityNotified.set('claw-B', 200);
    clawStateAPI.inactivityNotifyCount.set('claw-A', 1);
    clawStateAPI.clawPreviouslyAlive.set('claw-C', true);
    clawStateAPI.everSpawned.add('claw-C');
    clawStateAPI.clawPreviouslyNotified.set('claw-C', Date.now());

    // fs reports CLAWS_DIR does NOT exist
    vi.mocked(getChestnutFs).mockReturnValue(makeMockFs(false) as any);

    // act: 跑 maybeCronClawInactivity + Crash with CLAWS_DIR missing fs
    await maybeCronClawInactivity(mockPm, mockAudit as any, fsFactory);
    maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    // expect: 5 Maps 全清
    expect(clawStateAPI.lastInactivityNotified.size).toBe(0);
    expect(clawStateAPI.inactivityNotifyCount.size).toBe(0);
    expect(clawStateAPI.clawPreviouslyAlive.size).toBe(0);
    expect(clawStateAPI.everSpawned.size).toBe(0);
    expect(clawStateAPI.clawPreviouslyNotified.size).toBe(0);
  });

  it('reverse 2: CLAWS_DIR exists + all stale → existing cleanup still clears all', async () => {
    // setup: 1 claw dir 'claw-X' + Maps 含 claw-A/B（非 X）
    fs.mkdirSync(path.join(clawsDir, 'claw-X'), { recursive: true });
    clawStateAPI.lastInactivityNotified.set('claw-A', 100);
    clawStateAPI.lastInactivityNotified.set('claw-B', 200);
    clawStateAPI.inactivityNotifyCount.set('claw-A', 1);
    clawStateAPI.clawPreviouslyAlive.set('claw-A', true);
    clawStateAPI.everSpawned.add('claw-A');
    clawStateAPI.clawPreviouslyNotified.set('claw-A', Date.now());

    vi.mocked(getChestnutFs).mockReturnValue(makeMockFs(true) as any);

    // act: 跑 cron
    await maybeCronClawInactivity(mockPm, mockAudit as any, fsFactory);
    maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    // expect: Maps 不含 A/B、含 X 若有（这里 X 不在 Maps 中，所以全清）
    expect(clawStateAPI.lastInactivityNotified.has('claw-A')).toBe(false);
    expect(clawStateAPI.lastInactivityNotified.has('claw-B')).toBe(false);
    expect(clawStateAPI.inactivityNotifyCount.has('claw-A')).toBe(false);
    expect(clawStateAPI.clawPreviouslyAlive.has('claw-A')).toBe(false);
    expect(clawStateAPI.everSpawned.has('claw-A')).toBe(false);
    expect(clawStateAPI.clawPreviouslyNotified.has('claw-A')).toBe(false);
    // X 没有被加入（因为 clawHasActiveContract mocked false / pm.isAlive mocked false）
  });

  it('reverse 3: CLAWS_DIR exists + partial stale → only stale removed', async () => {
    // setup: 2 claw dirs (X, Y) + Maps 含 X, Y, Z（Z stale）
    fs.mkdirSync(path.join(clawsDir, 'claw-X'), { recursive: true });
    fs.mkdirSync(path.join(clawsDir, 'claw-Y'), { recursive: true });

    clawStateAPI.lastInactivityNotified.set('claw-X', 100);
    clawStateAPI.lastInactivityNotified.set('claw-Y', 200);
    clawStateAPI.lastInactivityNotified.set('claw-Z', 300);
    clawStateAPI.inactivityNotifyCount.set('claw-X', 1);
    clawStateAPI.inactivityNotifyCount.set('claw-Z', 2);
    clawStateAPI.clawPreviouslyAlive.set('claw-X', true);
    clawStateAPI.clawPreviouslyAlive.set('claw-Z', false);
    clawStateAPI.everSpawned.add('claw-X');
    clawStateAPI.everSpawned.add('claw-Z');
    clawStateAPI.clawPreviouslyNotified.set('claw-X', Date.now());
    clawStateAPI.clawPreviouslyNotified.set('claw-Z', Date.now() - 1000);

    vi.mocked(getChestnutFs).mockReturnValue(makeMockFs(true) as any);

    // act: 跑 cron
    await maybeCronClawInactivity(mockPm, mockAudit as any, fsFactory);
    maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

    // expect: X, Y 保留、Z 移除
    expect(clawStateAPI.lastInactivityNotified.has('claw-X')).toBe(true);
    expect(clawStateAPI.lastInactivityNotified.has('claw-Y')).toBe(true);
    expect(clawStateAPI.lastInactivityNotified.has('claw-Z')).toBe(false);

    expect(clawStateAPI.inactivityNotifyCount.has('claw-X')).toBe(true);
    expect(clawStateAPI.inactivityNotifyCount.has('claw-Z')).toBe(false);

    expect(clawStateAPI.clawPreviouslyAlive.has('claw-X')).toBe(true);
    expect(clawStateAPI.clawPreviouslyAlive.has('claw-Z')).toBe(false);

    expect(clawStateAPI.everSpawned.has('claw-X')).toBe(true);
    expect(clawStateAPI.everSpawned.has('claw-Z')).toBe(false);

    expect(clawStateAPI.clawPreviouslyNotified.has('claw-X')).toBe(true);
    expect(clawStateAPI.clawPreviouslyNotified.has('claw-Z')).toBe(false);
  });
});
