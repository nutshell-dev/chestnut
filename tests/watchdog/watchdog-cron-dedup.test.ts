/**
 * Watchdog crash_notification dedup tests (phase 1207 gap A)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawPreviouslyAlive, everSpawned, clawPreviouslyNotified } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { getMotionDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import { clawHasContract, gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { InboxWriter } from '../../src/foundation/messaging/index.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getMotionDir: vi.fn(),
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

describe('watchdog crash_notification dedup (phase 1207 gap A)', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: { write: ReturnType<typeof vi.fn> };
  let inboxWriteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `wd-dedup-${randomUUID()}`);
    const clawforumDir = path.join(tmpDir, '.clawforum');
    clawsDir = path.join(clawforumDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });
    fs.mkdirSync(path.join(clawforumDir, 'motion', 'inbox', 'pending'), { recursive: true });

    vi.mocked(getMotionDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(clawHasContract).mockReturnValue(true);
    vi.mocked(gatherClawSnapshot).mockReturnValue({
      contract: 'active:c1', outboxPending: 0, inboxPending: 0, status: 'stopped',
    } as any);

    mockPm = { isAlive: vi.fn() } as unknown as ProcessManager;
    mockAudit = { write: vi.fn() };
    inboxWriteMock = vi.fn();
    vi.mocked(InboxWriter).mockImplementation(() => ({ writeSync: inboxWriteMock } as any));

    // Reset state
    clawPreviouslyAlive.clear();
    everSpawned.clear();
    clawPreviouslyNotified.clear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reverse 1: first crash emits crash_notification and marks notified', () => {
    const clawId = `claw-dedup-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // wasAlive=true, currentlyAlive=false → crash (everSpawned pre-seeded as if claw was alive before)
    clawPreviouslyAlive.set(clawId, true);
    everSpawned.add(clawId);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);

    maybeCronClawCrash(mockPm, mockAudit as any);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    expect(inboxWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'crash_notification', source: clawId }),
    );
    expect(clawPreviouslyNotified.has(clawId)).toBe(true);
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
    clawPreviouslyAlive.set(clawId, true);
    everSpawned.add(clawId);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, mockAudit as any);
    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    inboxWriteMock.mockClear();

    // Second tick: same dead claw → skip
    maybeCronClawCrash(mockPm, mockAudit as any);

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
    clawPreviouslyAlive.set(clawId, true);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, mockAudit as any);
    expect(clawPreviouslyNotified.has(clawId)).toBe(true);
    inboxWriteMock.mockClear();

    // Recovery: claw becomes alive
    vi.mocked(mockPm.isAlive).mockReturnValue(true);
    maybeCronClawCrash(mockPm, mockAudit as any);

    expect(clawPreviouslyNotified.has(clawId)).toBe(false);
    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_RESET,
      `claw=${clawId}`,
      `reason=recovered_alive`,
    );

    // Next crash should re-emit (everSpawned pre-seeded)
    inboxWriteMock.mockClear();
    everSpawned.add(clawId);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, mockAudit as any);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    expect(inboxWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'crash_notification', source: clawId }),
    );
  });

  it('cleanup on dir vanish removes notified state', () => {
    const clawId = `claw-dedup-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    clawPreviouslyAlive.set(clawId, true);
    clawPreviouslyNotified.add(clawId);
    everSpawned.add(clawId);

    // Remove claw dir
    fs.rmSync(path.join(clawsDir, clawId), { recursive: true, force: true });

    maybeCronClawCrash(mockPm, mockAudit as any);

    expect(clawPreviouslyAlive.has(clawId)).toBe(false);
    expect(everSpawned.has(clawId)).toBe(false);
    expect(clawPreviouslyNotified.has(clawId)).toBe(false);
  });
});
