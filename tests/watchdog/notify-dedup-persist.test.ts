import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import {
  loadWatchdogState, saveWatchdogState,
} from '../../src/watchdog/watchdog-state.js';
import {
  clawPreviouslyAlive, everSpawned, clawPreviouslyNotified,
} from '../../src/watchdog/watchdog-context.js';
import { setAuditWriter } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
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

describe('watchdog notify dedup persist (phase 1269 sub-3)', () => {
  let tmpDir: string;
  let clawforumDir: string;
  let clawsDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let inboxWriteMock: ReturnType<typeof vi.fn>;
  let mockPm: ProcessManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-dedup-persist-${randomUUID()}`);
    clawforumDir = path.join(tmpDir, '.clawforum');
    clawsDir = path.join(clawforumDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });
    fs.mkdirSync(path.join(clawforumDir, 'motion', 'inbox', 'pending'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(clawHasContract).mockReturnValue(true);
    vi.mocked(gatherClawSnapshot).mockReturnValue({
      contract: 'active:c1', outboxPending: 0, inboxPending: 0, status: 'stopped',
    } as any);

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: clawforumDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');

    mockPm = { isAlive: vi.fn() } as unknown as ProcessManager;
    inboxWriteMock = vi.fn();
    vi.mocked(InboxWriter).mockImplementation(() => ({ writeSync: inboxWriteMock } as any));

    // Reset state
    clawPreviouslyAlive.clear();
    everSpawned.clear();
    clawPreviouslyNotified.clear();
  });

  afterEach(() => {
    setAuditWriter(null);
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('crash notify writes dedup to disk; reload skips re-emit + audits DEDUPED', () => {
    const clawId = `claw-persist-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // First crash
    clawPreviouslyAlive.set(clawId, true);
    everSpawned.add(clawId);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    expect(clawPreviouslyNotified.has(clawId)).toBe(true);

    // Save state (simulate end-of-tick save)
    saveWatchdogState();

    // Reset in-memory state (simulate watchdog restart)
    clawPreviouslyAlive.clear();
    everSpawned.clear();
    clawPreviouslyNotified.clear();

    // Reload state
    loadWatchdogState();
    expect(clawPreviouslyNotified.has(clawId)).toBe(true);

    // Simulate new process manager / audit
    inboxWriteMock.mockClear();
    auditSpy.mockClear();

    // Re-seed everSpawned so crash detection triggers
    everSpawned.add(clawId);
    clawPreviouslyAlive.set(clawId, true);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter);

    expect(inboxWriteMock).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DEDUPED,
      `claw=${clawId}`,
      `reason=already_notified`,
    );
  });

  it('alive recovery deletes dedup; save + reload allows re-emit', () => {
    const clawId = `claw-persist-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // First crash
    clawPreviouslyAlive.set(clawId, true);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter);
    expect(clawPreviouslyNotified.has(clawId)).toBe(true);
    saveWatchdogState();

    // Reset in-memory state
    clawPreviouslyAlive.clear();
    everSpawned.clear();
    clawPreviouslyNotified.clear();
    loadWatchdogState();
    expect(clawPreviouslyNotified.has(clawId)).toBe(true);

    // Alive recovery
    vi.mocked(mockPm.isAlive).mockReturnValue(true);
    maybeCronClawCrash(mockPm, auditWriter);
    expect(clawPreviouslyNotified.has(clawId)).toBe(false);
    saveWatchdogState();

    // Reset again
    clawPreviouslyAlive.clear();
    everSpawned.clear();
    clawPreviouslyNotified.clear();
    loadWatchdogState();
    expect(clawPreviouslyNotified.has(clawId)).toBe(false);

    // Next crash should re-emit
    inboxWriteMock.mockClear();
    everSpawned.add(clawId);
    clawPreviouslyAlive.set(clawId, true);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    expect(inboxWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'crash_notification', source: clawId }),
    );
  });

  it('v1 graceful-read: loads without clawPreviouslyNotified + first emit OK + save upgrades to v2', () => {
    const clawId = `claw-v1-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // Write v1 state file (no clawPreviouslyNotified field)
    const stateFile = path.join(clawforumDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 1,
      lastInactivityNotified: {},
      inactivityNotifyCount: {},
      clawPreviouslyAlive: {},
      everSpawned: [],
    }, null, 2));

    // Reset and load
    clawPreviouslyAlive.clear();
    everSpawned.clear();
    clawPreviouslyNotified.clear();
    loadWatchdogState();

    expect(clawPreviouslyNotified.has(clawId)).toBe(false);

    // First crash should emit
    clawPreviouslyAlive.set(clawId, true);
    everSpawned.add(clawId);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);

    // Save should write v2
    saveWatchdogState();
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(saved.schema_version).toBe(2);
    expect(saved.clawPreviouslyNotified).toBeDefined();
    expect(saved.clawPreviouslyNotified[clawId]).toBeDefined();
  });
});
