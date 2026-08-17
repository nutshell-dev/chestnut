/**
 * Phase 1396 Step H: watchdog durable state migration + schema invariant tests.
 *
 * Legacy notification Maps (lastInactivityNotified / inactivityNotifyCount /
 * clawPreviouslyAlive / everSpawned / clawPreviouslyNotified) are atomically
 * preserved to a migration record on first load, then retired from in-memory
 * state and future watchdog-state.json writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return { ...actual, getNamedSubrootDir: vi.fn() };
});
vi.mock('../../src/foundation/config-store/index.js', async (importOriginal) => {
  return { ...(await importOriginal<typeof import('../../src/foundation/config-store/index.js')>()) };
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
vi.mock('../../src/watchdog/workspace-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/watchdog/workspace-config.js')>()),
  readWorkspaceWatchdogConfig: vi.fn(),
}));

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { loadWatchdogState, saveWatchdogState } from '../../src/watchdog/watchdog-state.js';
import {
  setAuditWriter,
  _resetWatchdogContextForTest,
  motionRestartStateAPI,
  executorRestartStateAPI,
} from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('watchdog-state migration + schema invariants (Phase 1396 Step H)', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let stateFile: string;
  let migrationFile: string;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-migration-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    stateFile = path.join(chestnutDir, 'watchdog-state.json');
    migrationFile = path.join(chestnutDir, 'watchdog', 'migrations', 'phase1396-retired-notification-state.json');
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAudit() {
    return {
      write: vi.fn(),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    } as unknown as AuditLog;
  }

  const legacyFields = {
    lastInactivityNotified: { claw1: 1000 },
    inactivityNotifyCount: { claw1: 2 },
    clawPreviouslyAlive: { claw1: true },
    everSpawned: ['claw1'],
    clawPreviouslyNotified: { claw1: 500 },
  };

  it('schema_version 3 state round-trips motionRestart + executorRestart', () => {
    const motionRestart = {
      status: 'retrying' as const,
      consecutiveAttempts: 3,
      nextAttemptAt: 1_234_567_890,
      awaitingStability: true,
    };
    const executorRestart = {
      claw1: {
        status: 'open' as const,
        consecutiveAttempts: 2,
        openedAt: 1_234_567_000,
        sinkDelivered: true,
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 3,
      motionRestart,
      executorRestart,
    }));

    setAuditWriter(makeAudit());
    loadWatchdogState(fsFactory);

    expect(motionRestartStateAPI.snapshot()).toEqual(motionRestart);
    expect(executorRestartStateAPI.snapshot()).toEqual(executorRestart);

    saveWatchdogState(fsFactory);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(saved.schema_version).toBe(3);
    expect(saved.motionRestart).toEqual(motionRestart);
    expect(saved.executorRestart).toEqual(executorRestart);
    expect(saved).not.toHaveProperty('lastInactivityNotified');
  });

  it('legacy v2 notification fields are migrated, then absent from new state', () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 2,
      ...legacyFields,
    }));

    const audit = makeAudit();
    setAuditWriter(audit);
    loadWatchdogState(fsFactory);

    expect(fs.existsSync(migrationFile)).toBe(true);
    const record = JSON.parse(fs.readFileSync(migrationFile, 'utf-8'));
    expect(record.schema_version).toBe(1);
    expect(record.source_schema_version).toBe(2);
    expect(record.fields).toEqual(legacyFields);

    expect(audit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.NOTIFICATION_STATE_MIGRATED,
      expect.stringContaining('path='),
      expect.stringContaining('source_schema_version=2'),
    );

    // New in-memory state has no legacy Maps.
    expect(motionRestartStateAPI.snapshot()).toEqual({ status: 'closed', consecutiveAttempts: 0 });
    expect(executorRestartStateAPI.snapshot()).toEqual({});

    saveWatchdogState(fsFactory);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(saved.schema_version).toBe(3);
    expect(saved).not.toHaveProperty('lastInactivityNotified');
    expect(saved).not.toHaveProperty('inactivityNotifyCount');
    expect(saved).not.toHaveProperty('clawPreviouslyAlive');
    expect(saved).not.toHaveProperty('everSpawned');
    expect(saved).not.toHaveProperty('clawPreviouslyNotified');
  });

  it('second load with identical legacy fields is idempotent (no duplicate migration audit)', () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 2,
      ...legacyFields,
    }));

    const firstAudit = makeAudit();
    setAuditWriter(firstAudit);
    loadWatchdogState(fsFactory);
    expect(firstAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.NOTIFICATION_STATE_MIGRATED,
      expect.any(String),
      expect.any(String),
    );

    // Reset audit and reload the same legacy state file.
    const secondAudit = makeAudit();
    setAuditWriter(secondAudit);
    loadWatchdogState(fsFactory);

    expect(secondAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.NOTIFICATION_STATE_MIGRATED,
      expect.any(String),
      expect.any(String),
    );
  });

  it('conflicting migration record is fail-closed and emits conflict audit', () => {
    fs.mkdirSync(path.dirname(migrationFile), { recursive: true });
    fs.writeFileSync(migrationFile, JSON.stringify({
      schema_version: 1,
      source_schema_version: 2,
      retired_at: new Date().toISOString(),
      fields: { ...legacyFields, everSpawned: ['claw2'] },
    }));

    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 2,
      ...legacyFields,
    }));

    const audit = makeAudit();
    setAuditWriter(audit);

    expect(() => loadWatchdogState(fsFactory)).not.toThrow();

    expect(audit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.NOTIFICATION_STATE_MIGRATION_CONFLICT,
      expect.stringContaining('reason=field_mismatch'),
      expect.stringContaining('path='),
    );
    expect(audit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok='),
      expect.stringContaining('error='),
    );
  });

  it('missing state file is silent (no audit, no throw)', () => {
    const audit = makeAudit();
    setAuditWriter(audit);
    expect(() => loadWatchdogState(fsFactory)).not.toThrow();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('corrupt JSON emits STATE_LOAD_FAILED and quarantines the file', () => {
    fs.writeFileSync(stateFile, 'NOT_JSON{{{');
    const audit = makeAudit();
    setAuditWriter(audit);

    expect(() => loadWatchdogState(fsFactory)).not.toThrow();

    expect(audit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
      expect.stringContaining('backup='),
      'move_ok=true',
      expect.stringContaining('error='),
    );
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(fs.readdirSync(chestnutDir).some(f => f.includes('.corrupt-'))).toBe(true);
  });

  it('legacy `version: 1` file (no schema_version) is schema invalid', () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      ...legacyFields,
    }));
    const audit = makeAudit();
    setAuditWriter(audit);

    expect(() => loadWatchdogState(fsFactory)).not.toThrow();

    const schemaCall = audit.write.mock.calls.find((c) => c[0] === WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID);
    expect(schemaCall).toBeDefined();
    expect(schemaCall).toEqual(
      expect.arrayContaining([
        WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID,
        expect.stringContaining('reason=unknown_schema_version'),
        expect.stringContaining('current=3'),
      ]),
    );
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('future schema_version > current is schema invalid', () => {
    fs.writeFileSync(stateFile, JSON.stringify({ schema_version: 99 }));
    const audit = makeAudit();
    setAuditWriter(audit);

    expect(() => loadWatchdogState(fsFactory)).not.toThrow();

    const schemaCall = audit.write.mock.calls.find((c) => c[0] === WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID);
    expect(schemaCall).toBeDefined();
    expect(schemaCall).toEqual(
      expect.arrayContaining([
        WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID,
        expect.stringContaining('actual=99'),
        expect.stringContaining('current=3'),
      ]),
    );
  });

  it('malformed motionRestart quarantines file and resets state', () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 3,
      motionRestart: { status: 'retrying', consecutiveAttempts: -1 },
    }));
    const audit = makeAudit();
    setAuditWriter(audit);

    expect(() => loadWatchdogState(fsFactory)).not.toThrow();
    expect(motionRestartStateAPI.snapshot()).toEqual({ status: 'closed', consecutiveAttempts: 0 });

    const failedCall = audit.write.mock.calls.find((c) => c[0] === WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED);
    expect(failedCall).toBeDefined();
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});
