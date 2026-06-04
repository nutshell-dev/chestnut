/**
 * Watchdog everSpawned crash detection tests (phase 1047)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawStateAPI } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { getNamedSubrootDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { clawHasContract, gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { notifyClaw } from '../../src/foundation/messaging/index.js';
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

vi.mock('../../src/watchdog/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-utils.js')>();
  return {
    ...actual,
    clawHasContract: vi.fn(),
    clawHasActiveContract: vi.fn().mockReturnValue(true),
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

describe('watchdog everSpawned crash detection (phase 1047)', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
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
    mockAudit = { write: vi.fn() };

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
