import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/foundation/config/index.js';
import { loadGlobalConfig } from '../../src/assembly/config-load.js';
import {
  loadWatchdogState, saveWatchdogState,
} from '../../src/watchdog/watchdog-state.js';
import { clawStateAPI, setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawHasContract, gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { routeNotifyClaw } from '../../src/core/claw-topology/index.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

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

describe('watchdog notify dedup persist (phase 1269 sub-3)', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let clawsDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let inboxWriteMock: ReturnType<typeof vi.fn>;
  let mockPm: ProcessManager;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    tmpDir = path.join(os.tmpdir(), `wd-dedup-persist-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'motion', 'inbox', 'pending'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(clawHasContract).mockReturnValue(true);
    vi.mocked(gatherClawSnapshot).mockReturnValue({
      contract: 'active:c1', outboxPending: 0, inboxPending: 0, status: 'stopped',
    } as any);

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');

    mockPm = { isAlive: vi.fn() } as unknown as ProcessManager;
    inboxWriteMock = vi.fn();
    vi.mocked(routeNotifyClaw).mockImplementation(inboxWriteMock);

    // Reset state
    clawStateAPI.clawPreviouslyAlive.clear();
    clawStateAPI.everSpawned.clear();
    clawStateAPI.clawPreviouslyNotified.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('crash notify writes dedup to disk; reload skips re-emit + audits DEDUPED', () => {
    const clawId = `claw-persist-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // First crash
    clawStateAPI.clawPreviouslyAlive.set(clawId, true);
    clawStateAPI.everSpawned.add(clawId);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter, fsFactory);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(true);

    // Save state (simulate end-of-tick save)
    saveWatchdogState(fsFactory);

    // Reset in-memory state (simulate watchdog restart)
    clawStateAPI.clawPreviouslyAlive.clear();
    clawStateAPI.everSpawned.clear();
    clawStateAPI.clawPreviouslyNotified.clear();

    // Reload state
    loadWatchdogState(fsFactory);
    expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(true);

    // Simulate new process manager / audit
    inboxWriteMock.mockClear();
    auditSpy.mockClear();

    // Re-seed everSpawned so crash detection triggers
    clawStateAPI.everSpawned.add(clawId);
    clawStateAPI.clawPreviouslyAlive.set(clawId, true);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter, fsFactory);

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
    clawStateAPI.clawPreviouslyAlive.set(clawId, true);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter, fsFactory);
    expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(true);
    saveWatchdogState(fsFactory);

    // Reset in-memory state
    clawStateAPI.clawPreviouslyAlive.clear();
    clawStateAPI.everSpawned.clear();
    clawStateAPI.clawPreviouslyNotified.clear();
    loadWatchdogState(fsFactory);
    expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(true);

    // Alive recovery
    vi.mocked(mockPm.isAlive).mockReturnValue(true);
    maybeCronClawCrash(mockPm, auditWriter, fsFactory);
    expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(false);
    saveWatchdogState(fsFactory);

    // Reset again
    clawStateAPI.clawPreviouslyAlive.clear();
    clawStateAPI.everSpawned.clear();
    clawStateAPI.clawPreviouslyNotified.clear();
    loadWatchdogState(fsFactory);
    expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(false);

    // Next crash should re-emit
    inboxWriteMock.mockClear();
    clawStateAPI.everSpawned.add(clawId);
    clawStateAPI.clawPreviouslyAlive.set(clawId, true);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter, fsFactory);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    expect(inboxWriteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'motion',
      'motion',
      expect.objectContaining({ type: 'crash_notification', source: clawId }),
      expect.anything(),
    );
  });

  it('v1 graceful-read: loads without clawPreviouslyNotified + first emit OK + save upgrades to v2', () => {
    const clawId = `claw-v1-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // Write v1 state file (no clawPreviouslyNotified field)
    const stateFile = path.join(chestnutDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 1,
      lastInactivityNotified: {},
      inactivityNotifyCount: {},
      clawPreviouslyAlive: {},
      everSpawned: [],
    }, null, 2));

    // Reset and load
    clawStateAPI.clawPreviouslyAlive.clear();
    clawStateAPI.everSpawned.clear();
    clawStateAPI.clawPreviouslyNotified.clear();
    loadWatchdogState(fsFactory);

    expect(clawStateAPI.clawPreviouslyNotified.has(clawId)).toBe(false);

    // First crash should emit
    clawStateAPI.clawPreviouslyAlive.set(clawId, true);
    clawStateAPI.everSpawned.add(clawId);
    vi.mocked(mockPm.isAlive).mockReturnValue(false);
    maybeCronClawCrash(mockPm, auditWriter, fsFactory);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);

    // Save should write v2
    saveWatchdogState(fsFactory);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(saved.schema_version).toBe(2);
    expect(saved.clawPreviouslyNotified).toBeDefined();
    expect(saved.clawPreviouslyNotified[clawId]).toBeDefined();
  });
});
