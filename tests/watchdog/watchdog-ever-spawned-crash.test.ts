/**
 * Watchdog everSpawned crash detection tests (phase 1047)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawPreviouslyAlive, everSpawned } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { getNamedSubrootDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { clawHasContract, gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { InboxWriter } from '../../src/foundation/messaging/index.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

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
    gatherClawSnapshot: vi.fn(),
  };
});

vi.mock('../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/messaging/index.js')>();
  return {
    ...actual,
    InboxWriter: vi.fn().mockImplementation(() => ({
      writeSync: vi.fn(),
    })),
  };
});

describe('watchdog everSpawned crash detection (phase 1047)', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `wd-ever-${randomUUID()}`);
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

    mockPm = { isAlive: vi.fn() } as unknown as ProcessManager;
    mockAudit = { write: vi.fn() };

    // Reset state
    clawPreviouslyAlive.clear();
    everSpawned.clear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('first-tick crash detected via everSpawned when clawPreviouslyAlive lacks entry', () => {
    const clawId = `claw-ever-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // Pre-seed everSpawned (simulating prior tick saw it alive)
    everSpawned.add(clawId);
    // clawPreviouslyAlive does NOT have clawId (cleanup or first tick)
    // isAlive returns false (crashed)
    vi.mocked(mockPm.isAlive).mockReturnValue(false);

    maybeCronClawCrash(mockPm, mockAudit as any);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
      expect.stringContaining(clawId),
      'has_contract=true',
      'detected_by=ever_spawned',
    );
  });

  it('everSpawned cleanup when claw dir removed', () => {
    const clawId = `claw-cleanup-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // Establish state
    everSpawned.add(clawId);
    clawPreviouslyAlive.set(clawId, false);

    // Now remove claw dir
    fs.rmSync(path.join(clawsDir, clawId), { recursive: true, force: true });

    maybeCronClawCrash(mockPm, mockAudit as any);

    expect(everSpawned.has(clawId)).toBe(false);
    expect(clawPreviouslyAlive.has(clawId)).toBe(false);
  });
});
