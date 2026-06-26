/**
 * Phase 1134 + 311 — watchdog-state.json schema_version invariant + strict-end
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// Mock config so getChestnutDir() returns controllable values
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

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config/config-load.js';
import {
  loadWatchdogState,
  saveWatchdogState,
} from '../../src/watchdog/watchdog-state.js';
import { clawStateAPI, setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('watchdog-state schema_version invariant — phase 1134 + 311 strict-end', () => {
  let tmpDir: string;
  let chestnutDir: string;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    tmpDir = path.join(os.tmpdir(), `wd-schema-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects schema_version > CURRENT and emits STATE_SCHEMA_INVALID + backup', () => {
    const stateFile = path.join(chestnutDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 99,
      lastInactivityNotified: {},
      inactivityNotifyCount: {},
      clawPreviouslyAlive: {},
      everSpawned: [],
    }));

    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as unknown as AuditLog;
    setAuditWriter(mockAudit);

    // Should not throw to caller
    expect(() => loadWatchdogState(fsFactory)).not.toThrow();

    // Maps should be reset to empty
    expect(clawStateAPI.lastInactivityNotified.size).toBe(0);
    expect(clawStateAPI.inactivityNotifyCount.size).toBe(0);
    expect(clawStateAPI.clawPreviouslyAlive.size).toBe(0);
    expect(clawStateAPI.everSpawned.size).toBe(0);

    // Audit should contain STATE_SCHEMA_INVALID with reason and actual version
    const auditCalls = mockAudit.write.mock.calls;
    const schemaCall = auditCalls.find((c: any[]) => c[0] === WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID);
    expect(schemaCall).toBeDefined();
    expect(schemaCall).toEqual(
      expect.arrayContaining([
        WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID,
        expect.stringContaining('backup='),
        expect.stringContaining('reason=unknown_schema_version'),
        expect.stringContaining('actual=99'),
        expect.stringContaining('current=2'),
        expect.stringContaining('move_ok=true'),
      ]),
    );

    // Original file should be quarantined (backed up)
    expect(fs.existsSync(stateFile)).toBe(false);
    const files = fs.readdirSync(chestnutDir);
    expect(files.some(f => f.match(/watchdog-state\.json\.corrupt-\d+/))).toBe(true);
  });

  it('rejects legacy `version: 1` file (without schema_version) as schema invalid — phase 311 strict-end', () => {
    const stateFile = path.join(chestnutDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      lastInactivityNotified: { claw1: 100 },
      inactivityNotifyCount: { claw1: 2 },
      clawPreviouslyAlive: { claw1: true },
      everSpawned: ['claw1'],
    }));

    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as unknown as AuditLog;
    setAuditWriter(mockAudit);

    // Should not throw to caller
    expect(() => loadWatchdogState(fsFactory)).not.toThrow();

    // Maps should be reset to empty
    expect(clawStateAPI.lastInactivityNotified.size).toBe(0);
    expect(clawStateAPI.inactivityNotifyCount.size).toBe(0);
    expect(clawStateAPI.clawPreviouslyAlive.size).toBe(0);
    expect(clawStateAPI.everSpawned.size).toBe(0);

    // Audit should contain STATE_SCHEMA_INVALID (not legacy fallback)
    const auditCalls = mockAudit.write.mock.calls;
    const schemaCall = auditCalls.find((c: any[]) => c[0] === WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID);
    expect(schemaCall).toBeDefined();

    // Must NOT emit legacy fallback audit event
    const fallbackCall = auditCalls.find((c: any[]) => c[0] === 'watchdog_state_legacy_version_fallback');
    expect(fallbackCall).toBeUndefined();

    // Original file should be quarantined
    expect(fs.existsSync(stateFile)).toBe(false);
    const files = fs.readdirSync(chestnutDir);
    expect(files.some(f => f.match(/watchdog-state\.json\.corrupt-\d+/))).toBe(true);
  });

  it('accepts schema_version: 2 and saves back schema_version: 2', () => {
    const stateFile = path.join(chestnutDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 2,
      lastInactivityNotified: { claw1: 200 },
      inactivityNotifyCount: { claw1: 3 },
      clawPreviouslyAlive: { claw1: false },
      everSpawned: ['claw1'],
    }));

    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as unknown as AuditLog;
    setAuditWriter(mockAudit);

    loadWatchdogState(fsFactory);

    // No schema-related audit errors
    const badEvents = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED || c[0] === WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID,
    );
    expect(badEvents).toHaveLength(0);

    // Maps loaded successfully
    expect(clawStateAPI.lastInactivityNotified.get('claw1')).toBe(200);
    expect(clawStateAPI.inactivityNotifyCount.get('claw1')).toBe(3);
    expect(clawStateAPI.clawPreviouslyAlive.get('claw1')).toBe(false);
    expect(clawStateAPI.everSpawned.has('claw1')).toBe(true);

    // Subsequent save writes schema_version, not version
    saveWatchdogState(fsFactory);
    const savedRaw = fs.readFileSync(stateFile, 'utf-8');
    const saved = JSON.parse(savedRaw);
    expect(saved.schema_version).toBe(2);
    expect(saved).not.toHaveProperty('version');
  });
});
