/**
 * Watchdog maybeCronClawCrash 三分判定 audit 完整性 (phase 133)
 *
 * B1 silent skip → audit emit (CLAW_CRASH_SKIPPED_NO_CONTRACT)
 * B2 deduped → audit emit (CLAW_CRASH_NOTIFY_DEDUPED) (existing)
 * B3 detected → audit emit (CLAW_CRASH_DETECTED) + notifyClaw (existing)
 * alive → 0 dead sub-branch audit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawStateAPI, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { getNamedSubrootDir } from '../../src/foundation/config/index.js';
import { loadGlobalConfig } from '../../src/assembly/config-load.js';
import { clawHasContract, clawHasActiveContract, gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { routeNotifyClaw } from '../../src/core/claw-topology/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});
vi.mock('../../src/assembly/config-load.js', async () => {
  const foundation = await import('../../src/foundation/config/index.js');
  return {
    loadGlobalConfig: foundation.loadGlobalConfig,
    isInitialized: vi.fn(),
    saveGlobalConfig: vi.fn(),
    loadClawConfig: vi.fn(),
    patchGlobalConfigPrimary: vi.fn(),
    saveClawConfig: vi.fn(),
    clawExists: vi.fn(() => true),
    buildLLMConfig: vi.fn(),
  };
});

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

describe('maybeCronClawCrash 三分判定 audit 完整性 (phase 133)', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: { write: ReturnType<typeof vi.fn> };
  let inboxWriteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetWatchdogContextForTest();
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
