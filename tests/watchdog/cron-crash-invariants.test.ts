/**
 * cron crash invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - watchdog-cron-skip-audit.test.ts
 *  - watchdog-cron-dedup.test.ts
 *  - watchdog-ever-spawned-crash.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawStateAPI, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config/config-load.js';
import { clawHasContract, clawHasActiveContract, gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { routeNotifyClaw } from '../../src/core/claw-topology/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { notifyClaw } from '../../src/foundation/messaging/index.js';

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

vi.mock('../../src/watchdog/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-utils.js')>();
  return {
    ...actual,
    clawHasContract: vi.fn(),
    clawHasActiveContract: vi.fn().mockReturnValue(true),
    gatherClawSnapshot: vi.fn(),
  };
});

vi.mock('../../src/core/claw-topology/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/index.js')>();
  return {
    ...actual,
    routeNotifyClaw: vi.fn(),
  };
});

vi.mock('../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/messaging/index.js')>();
  return {
    ...actual,
    notifyClaw: vi.fn(),
  };
});

describe('watchdog-cron-skip-audit', () => {
  /**
   * Watchdog maybeCronClawCrash 三分判定 audit 完整性 (phase 133)
   *
   * B1 silent skip → audit emit (CLAW_CRASH_SKIPPED_NO_CONTRACT)
   * B2 deduped → audit emit (CLAW_CRASH_NOTIFY_DEDUPED) (existing)
   * B3 detected → audit emit (CLAW_CRASH_DETECTED) + notifyClaw (existing)
   * alive → 0 dead sub-branch audit
   */

  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  describe('maybeCronClawCrash 三分判定 audit 完整性 (phase 133)', () => {
    let tmpDir: string;
    let clawsDir: string;
    let mockPm: ProcessManager;
    let mockAudit: { write: ReturnType<typeof vi.fn> };
    let inboxWriteMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      _resetWatchdogContextForTest();
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      tmpDir = path.join(tmpdir(), `wd-skip-${randomUUID()}`);
      const chestnutDir = path.join(tmpDir, '.chestnut');
      clawsDir = path.join(chestnutDir, 'claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.mkdirSync(path.join(chestnutDir, 'motion', 'inbox', 'pending'), { recursive: true });

      vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
      vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
      vi.mocked(clawHasContract).mockReturnValue(true);
      vi.mocked(gatherClawSnapshot).mockReturnValue({
        contract: 'active:c1', outboxPending: 0, inboxPending: 0, status: 'stopped',
      } as any);

      mockPm = { isAlive: vi.fn() } as unknown as ProcessManager;
      mockAudit = {
        write: vi.fn(),
        preview: vi.fn((s: string) => s),
        message: vi.fn((s: string) => s),
        summary: vi.fn((s: string) => s),
      };
      inboxWriteMock = vi.fn();
      vi.mocked(routeNotifyClaw).mockImplementation(inboxWriteMock);

      // Reset state
      clawStateAPI.clawPreviouslyAlive.clear();
      clawStateAPI.everSpawned.clear();
      clawStateAPI.clawPreviouslyNotified.clear();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('反向 1: dead claw + no active contract → emit CLAW_CRASH_SKIPPED_NO_CONTRACT', () => {
      const clawId = `claw-skip-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      vi.mocked(mockPm.isAlive).mockReturnValue(false);
      vi.mocked(clawHasActiveContract as any).mockReturnValue(false);

      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(mockAudit.write).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_SKIPPED_NO_CONTRACT,
        `claw=${clawId}`,
        `reason=no_active_contract`,
      );
      expect(inboxWriteMock).not.toHaveBeenCalled();
    });

    it('反向 2: dead claw + active contract + already notified → emit CLAW_CRASH_NOTIFY_DEDUPED', () => {
      const clawId = `claw-dedup-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      clawStateAPI.clawPreviouslyNotified.set(clawId, Date.now());
      vi.mocked(mockPm.isAlive).mockReturnValue(false);
      vi.mocked(clawHasActiveContract as any).mockReturnValue(true);

      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(mockAudit.write).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DEDUPED,
        `claw=${clawId}`,
        `reason=already_notified`,
      );
      expect(mockAudit.write).not.toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_SKIPPED_NO_CONTRACT,
        expect.anything(),
        expect.anything(),
      );
      expect(inboxWriteMock).not.toHaveBeenCalled();
    });

    it('反向 3: dead claw + active contract + !notified → emit CLAW_CRASH_DETECTED + notifyClaw', () => {
      const clawId = `claw-detect-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      vi.mocked(mockPm.isAlive).mockReturnValue(false);
      vi.mocked(clawHasActiveContract as any).mockReturnValue(true);

      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(mockAudit.write).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
        expect.stringContaining(clawId),
        'has_contract=true',
        expect.any(String),
      );
      expect(mockAudit.write).not.toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_SKIPPED_NO_CONTRACT,
        expect.anything(),
        expect.anything(),
      );
      expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    });

    it('反向 4: alive claw → 0 dead sub-branch audit', () => {
      const clawId = `claw-alive-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      vi.mocked(mockPm.isAlive).mockReturnValue(true);

      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      const deadEvents = [
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_SKIPPED_NO_CONTRACT,
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DEDUPED,
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
      ];
      for (const eventType of deadEvents) {
        const callsForEvent = vi.mocked(mockAudit.write).mock.calls.filter(
          (call) => call[0] === eventType,
        );
        expect(callsForEvent).toHaveLength(0);
      }
      expect(inboxWriteMock).not.toHaveBeenCalled();
    });
  });
});

describe('watchdog-cron-dedup', () => {
  /**
   * Watchdog claw_crashed dedup tests (phase 1207 gap A)
   */

  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  describe('watchdog claw_crashed dedup (phase 1207 gap A)', () => {
    let tmpDir: string;
    let clawsDir: string;
    let mockPm: ProcessManager;
    let mockAudit: { write: ReturnType<typeof vi.fn> };
    let inboxWriteMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      _resetWatchdogContextForTest();
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      tmpDir = path.join(tmpdir(), `wd-dedup-${randomUUID()}`);
      const chestnutDir = path.join(tmpDir, '.chestnut');
      clawsDir = path.join(chestnutDir, 'claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.mkdirSync(path.join(chestnutDir, 'motion', 'inbox', 'pending'), { recursive: true });

      vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
      vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
      vi.mocked(clawHasContract).mockReturnValue(true);
      vi.mocked(gatherClawSnapshot).mockReturnValue({
        contract: 'active:c1', outboxPending: 0, inboxPending: 0, status: 'stopped',
      } as any);

      mockPm = { isAlive: vi.fn() } as unknown as ProcessManager;
      mockAudit = {
        write: vi.fn(),
        preview: vi.fn((s: string) => s),
        message: vi.fn((s: string) => s),
        summary: vi.fn((s: string) => s),
      };
      inboxWriteMock = vi.fn();
      vi.mocked(routeNotifyClaw).mockImplementation(inboxWriteMock);

      // Reset state
      clawStateAPI.clawPreviouslyAlive.clear();
      clawStateAPI.everSpawned.clear();
      clawStateAPI.clawPreviouslyNotified.clear();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('reverse 1: first crash emits claw_crashed and marks notified', () => {
      const clawId = `claw-dedup-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      // wasAlive=true, currentlyAlive=false → crash (everSpawned pre-seeded as if claw was alive before)
      clawStateAPI.clawPreviouslyAlive.set(clawId, true);
      clawStateAPI.everSpawned.add(clawId);
      vi.mocked(mockPm.isAlive).mockReturnValue(false);

      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(inboxWriteMock).toHaveBeenCalledTimes(1);
      expect(inboxWriteMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'motion',
        'motion',
        expect.objectContaining({ type: 'claw_crashed', source: clawId }),
        expect.anything(),
      );
      expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(true);
      expect(mockAudit.write).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
        expect.stringContaining(clawId),
        'has_contract=true',
        expect.any(String),
      );
    });

    it('reverse 2: subsequent ticks skip re-emit and audit deduped', () => {
      const clawId = `claw-dedup-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      // First crash (everSpawned pre-seeded as if claw was alive before)
      clawStateAPI.clawPreviouslyAlive.set(clawId, true);
      clawStateAPI.everSpawned.add(clawId);
      vi.mocked(mockPm.isAlive).mockReturnValue(false);
      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);
      expect(inboxWriteMock).toHaveBeenCalledTimes(1);
      inboxWriteMock.mockClear();

      // Second tick: same dead claw → skip
      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(inboxWriteMock).not.toHaveBeenCalled();
      expect(mockAudit.write).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DEDUPED,
        `claw=${clawId}`,
        `reason=already_notified`,
      );
    });

    it('reverse 3: alive recovery resets notify state so next crash re-emits', () => {
      const clawId = `claw-dedup-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      // First crash
      clawStateAPI.clawPreviouslyAlive.set(clawId, true);
      vi.mocked(mockPm.isAlive).mockReturnValue(false);
      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);
      expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(true);
      inboxWriteMock.mockClear();

      // Recovery: claw becomes alive
      vi.mocked(mockPm.isAlive).mockReturnValue(true);
      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(false);
      expect(mockAudit.write).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_RESET,
        `claw=${clawId}`,
        `reason=recovered_alive`,
      );

      // Next crash should re-emit (everSpawned pre-seeded)
      inboxWriteMock.mockClear();
      clawStateAPI.everSpawned.add(clawId);
      vi.mocked(mockPm.isAlive).mockReturnValue(false);
      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(inboxWriteMock).toHaveBeenCalledTimes(1);
      expect(inboxWriteMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'motion',
        'motion',
        expect.objectContaining({ type: 'claw_crashed', source: clawId }),
        expect.anything(),
      );
    });

    it('cleanup on dir vanish removes notified state', () => {
      const clawId = `claw-dedup-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      clawStateAPI.clawPreviouslyAlive.set(clawId, true);
      clawStateAPI.clawPreviouslyNotified.set(clawId, Date.now());
      clawStateAPI.everSpawned.add(clawId);

      // Remove claw dir
      fs.rmSync(path.join(clawsDir, clawId), { recursive: true, force: true });

      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(clawStateAPI.clawPreviouslyAlive.has(clawId)).toBe(false);
      expect(clawStateAPI.everSpawned.has(clawId)).toBe(false);
      expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(false);
    });
  });
});

describe('watchdog-ever-spawned-crash', () => {
  /**
   * Watchdog everSpawned crash detection tests (phase 1047)
   */

  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  describe('watchdog everSpawned crash detection (phase 1047)', () => {
    let tmpDir: string;
    let clawsDir: string;
    let mockPm: ProcessManager;
    let mockAudit: { write: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      _resetWatchdogContextForTest();
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      tmpDir = path.join(tmpdir(), `wd-ever-${randomUUID()}`);
      const chestnutDir = path.join(tmpDir, '.chestnut');
      clawsDir = path.join(chestnutDir, 'claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.mkdirSync(path.join(chestnutDir, 'motion', 'inbox', 'pending'), { recursive: true });

      vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
      vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
      vi.mocked(clawHasContract).mockReturnValue(true);
      vi.mocked(gatherClawSnapshot).mockReturnValue({
        contract: 'c1', outboxPending: 0, inboxPending: 0, status: 'alive',
      } as any);

      mockPm = { isAlive: vi.fn() } as unknown as ProcessManager;
      mockAudit = {
        write: vi.fn(),
        preview: vi.fn((s: string) => s),
        message: vi.fn((s: string) => s),
        summary: vi.fn((s: string) => s),
      };

      // Reset state
      clawStateAPI.clawPreviouslyAlive.clear();
      clawStateAPI.everSpawned.clear();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('first-tick crash detected via everSpawned when clawPreviouslyAlive lacks entry', () => {
      const clawId = `claw-ever-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      // Pre-seed everSpawned (simulating prior tick saw it alive)
      clawStateAPI.everSpawned.add(clawId);
      // clawPreviouslyAlive does NOT have clawId (cleanup or first tick)
      // isAlive returns false (crashed)
      vi.mocked(mockPm.isAlive).mockReturnValue(false);

      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      // phase 2 γ4 reframe: trigger 不再依赖 wasAlive||everSpawned / 直接 !alive+activeContract+!notified
      // audit field detected_by 砍 / 改为 crash_class (active_unexpected when no clean-stop marker)
      expect(mockAudit.write).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
        expect.stringContaining(clawId),
        'has_contract=true',
        'crash_class=active_unexpected',
      );
    });

    it('everSpawned cleanup when claw dir removed', () => {
      const clawId = `claw-cleanup-${randomUUID().slice(0, 8)}`;
      fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

      // Establish state
      clawStateAPI.everSpawned.add(clawId);
      clawStateAPI.clawPreviouslyAlive.set(clawId, false);

      // Now remove claw dir
      fs.rmSync(path.join(clawsDir, clawId), { recursive: true, force: true });

      maybeCronClawCrash(mockPm, mockAudit as any, fsFactory);

      expect(clawStateAPI.everSpawned.has(clawId)).toBe(false);
      expect(clawStateAPI.clawPreviouslyAlive.has(clawId)).toBe(false);
    });
  });
});
