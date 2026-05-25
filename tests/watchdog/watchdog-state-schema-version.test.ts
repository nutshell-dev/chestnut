/**
 * Phase 1134 — watchdog-state.json schema_version invariant + legacy graceful read
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// Mock config so getClawforumDir() returns controllable values
vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

import { getNamedSubrootDir, loadGlobalConfig } from '../../src/foundation/config/index.js';
import {
  loadWatchdogState,
  saveWatchdogState,
} from '../../src/watchdog/watchdog-state.js';
import {
  lastInactivityNotified,
  inactivityNotifyCount,
  clawPreviouslyAlive,
  everSpawned,
  setAuditWriter,
} from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

describe('watchdog-state schema_version invariant — phase 1134', () => {
  let tmpDir: string;
  let clawforumDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wd-schema-${randomUUID()}`);
    clawforumDir = path.join(tmpDir, '.clawforum');
    fs.mkdirSync(clawforumDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);
  });

  afterEach(() => {
    setAuditWriter(null);
    lastInactivityNotified.clear();
    inactivityNotifyCount.clear();
    clawPreviouslyAlive.clear();
    everSpawned.clear();
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects schema_version > CURRENT and emits STATE_SCHEMA_INVALID + backup', () => {
    const stateFile = path.join(clawforumDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      schema_version: 99,
      lastInactivityNotified: {},
      inactivityNotifyCount: {},
      clawPreviouslyAlive: {},
      everSpawned: [],
    }));

    const mockAudit = { write: vi.fn() } as unknown as AuditLog;
    setAuditWriter(mockAudit);

    // Should not throw to caller
    expect(() => loadWatchdogState()).not.toThrow();

    // Maps should be reset to empty
    expect(lastInactivityNotified.size).toBe(0);
    expect(inactivityNotifyCount.size).toBe(0);
    expect(clawPreviouslyAlive.size).toBe(0);
    expect(everSpawned.size).toBe(0);

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
    const files = fs.readdirSync(clawforumDir);
    expect(files.some(f => f.match(/watchdog-state\.json\.corrupt-\d+/))).toBe(true);
  });

  it('reads legacy `version: 1` file (without schema_version) gracefully', () => {
    const stateFile = path.join(clawforumDir, 'watchdog-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      lastInactivityNotified: { claw1: 100 },
      inactivityNotifyCount: { claw1: 2 },
      clawPreviouslyAlive: { claw1: true },
      everSpawned: ['claw1'],
    }));

    const mockAudit = { write: vi.fn() } as unknown as AuditLog;
    setAuditWriter(mockAudit);

    loadWatchdogState();

    // No schema-related audit errors
    const badEvents = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED || c[0] === WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID,
    );
    expect(badEvents).toHaveLength(0);

    // Maps loaded successfully from legacy file
    expect(lastInactivityNotified.get('claw1')).toBe(100);
    expect(inactivityNotifyCount.get('claw1')).toBe(2);
    expect(clawPreviouslyAlive.get('claw1')).toBe(true);
    expect(everSpawned.has('claw1')).toBe(true);

    // Subsequent save writes schema_version, not version
    saveWatchdogState();
    const savedRaw = fs.readFileSync(stateFile, 'utf-8');
    const saved = JSON.parse(savedRaw);
    expect(saved.schema_version).toBe(2);
    expect(saved).not.toHaveProperty('version');
  });
});
