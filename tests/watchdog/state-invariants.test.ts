/**
 * state invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - watchdog-state-narrow.test.ts
 *  - watchdog-utils-snapshot-forensic.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadWatchdogState } from '../../src/watchdog/watchdog-state.js';
import { clawStateAPI, _resetWatchdogContextForTest, getChestnutFs, getAuditWriter } from '../../src/watchdog/watchdog-context.js';
import { FileNotFoundError } from '../../src/foundation/fs/types.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import type { ClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

vi.mock('../../src/watchdog/watchdog-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-context.js')>();
  return {
    ...actual,
    getChestnutFs: vi.fn(),
    getAuditWriter: vi.fn(),
  };
});

describe('watchdog-state-narrow', () => {
  /**
   * Phase 1215: loadWatchdogState isFileNotFound dual-code narrow
   *
   * 反向测试：
   * 1. FileNotFoundError (FileSystem abstract layer FS_NOT_FOUND) → 0 audit emit + Maps stay empty
   * 2. raw ENOENT → 0 audit emit + Maps stay empty
   * 3. corrupt JSON (non-file-not-found) → emit STATE_LOAD_FAILED + Maps cleared
   */

  describe('loadWatchdogState dual-code narrow (phase 1215)', () => {
    beforeEach(() => {
      _resetWatchdogContextForTest();
      vi.restoreAllMocks();
      clawStateAPI.lastInactivityNotified.clear();
      clawStateAPI.inactivityNotifyCount.clear();
      clawStateAPI.clawPreviouslyAlive.clear();
      clawStateAPI.everSpawned.clear();
    });

    afterEach(() => {
      // phase 254: cleanup migrated to beforeEach _resetWatchdogContextForTest()
    });

    it('reverse 1: FileNotFoundError → 0 audit emit + Maps empty', () => {
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      vi.mocked(getAuditWriter).mockReturnValue(audit as any);
      vi.mocked(getChestnutFs).mockReturnValue({
        readSync: vi.fn().mockImplementation(() => {
          throw new FileNotFoundError('watchdog-state.json');
        }),
      } as any);

      loadWatchdogState();

      expect(audit.write).not.toHaveBeenCalled();
      expect(clawStateAPI.lastInactivityNotified.size).toBe(0);
      expect(clawStateAPI.inactivityNotifyCount.size).toBe(0);
      expect(clawStateAPI.clawPreviouslyAlive.size).toBe(0);
      expect(clawStateAPI.everSpawned.size).toBe(0);
    });

    it('reverse 2: raw ENOENT → 0 audit emit + Maps empty', () => {
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      vi.mocked(getAuditWriter).mockReturnValue(audit as any);
      const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
      vi.mocked(getChestnutFs).mockReturnValue({
        readSync: vi.fn().mockImplementation(() => {
          throw err;
        }),
      } as any);

      loadWatchdogState();

      expect(audit.write).not.toHaveBeenCalled();
      expect(clawStateAPI.lastInactivityNotified.size).toBe(0);
      expect(clawStateAPI.inactivityNotifyCount.size).toBe(0);
      expect(clawStateAPI.clawPreviouslyAlive.size).toBe(0);
      expect(clawStateAPI.everSpawned.size).toBe(0);
    });

    it('reverse 3: corrupt JSON → emit STATE_LOAD_FAILED + Maps cleared', () => {
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      vi.mocked(getAuditWriter).mockReturnValue(audit as any);
      vi.mocked(getChestnutFs).mockReturnValue({
        readSync: vi.fn().mockReturnValue('{broken json'),
        moveSync: vi.fn().mockReturnValue(undefined),
      } as any);

      loadWatchdogState();

      expect(audit.write).toHaveBeenCalledWith(
        WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
        expect.stringContaining('backup='),
        expect.stringContaining('move_ok=true'),
        expect.stringContaining('error='),
      );
      expect(clawStateAPI.lastInactivityNotified.size).toBe(0);
      expect(clawStateAPI.inactivityNotifyCount.size).toBe(0);
      expect(clawStateAPI.clawPreviouslyAlive.size).toBe(0);
      expect(clawStateAPI.everSpawned.size).toBe(0);
    });
  });
});

describe('watchdog-utils-snapshot-forensic', () => {
  /**
   * Watchdog gatherClawSnapshot forensic context tests (phase 1207 gap B)
   */

  describe('gatherClawSnapshot forensic context (phase 1207 gap B)', () => {
    let testDir: string;
    let clawDir: string;
    const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

    beforeEach(() => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      testDir = path.join(tmpdir(), `wd-snap-${randomUUID()}`);
      clawDir = path.join(testDir, 'claw-test');
      fs.mkdirSync(clawDir, { recursive: true });
      fs.mkdirSync(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
      fs.mkdirSync(path.join(clawDir, 'outbox', 'pending'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    const mockPm = { isAlive: () => false };

    it('reverse 1: claw audit.tsv has N+ lines → lastAuditEvents contains last 5', () => {
      const lines = [
        '2026-01-01T00:00:00Z\tevent_a\tdata1',
        '2026-01-01T00:01:00Z\tevent_b\tdata2',
        '2026-01-01T00:02:00Z\tevent_c\tdata3',
        '2026-01-01T00:03:00Z\tevent_d\tdata4',
        '2026-01-01T00:04:00Z\tevent_e\tdata5',
        '2026-01-01T00:05:00Z\tevent_f\tdata6',
        '2026-01-01T00:06:00Z\tevent_g\tdata7',
      ];
      fs.writeFileSync(path.join(clawDir, 'audit.tsv'), lines.join('\n') + '\n', 'utf-8');

      const snapshot = gatherClawSnapshot(clawDir, fsFactory, mockPm, 'claw-test');

      expect(snapshot.lastAuditEvents).toHaveLength(5);
      expect(snapshot.lastAuditEvents).toEqual(lines.slice(-5));
    });

    it('reverse 2: claw audit.tsv missing → lastAuditEvents undefined gracefully', () => {
      const snapshot = gatherClawSnapshot(clawDir, fsFactory, mockPm, 'claw-test');

      expect(snapshot.lastAuditEvents).toBeUndefined();
    });

    it('reverse 3: claw_crashed body includes last_events segment', () => {
      const auditLines = [
        '2026-01-01T00:00:00Z\tturn_start\t1',
        '2026-01-01T00:01:00Z\tturn_error\ttimeout',
      ];
      fs.writeFileSync(path.join(clawDir, 'audit.tsv'), auditLines.join('\n') + '\n', 'utf-8');

      // Use real gatherClawSnapshot through a mini integration path
      const snapshot = gatherClawSnapshot(clawDir, fsFactory, mockPm, 'claw-test');
      expect(snapshot.lastAuditEvents).toBeDefined();

      const lastEventsStr = snapshot.lastAuditEvents!.map(e => e.replace(/\t/g, '|')).join(' >> ');
      expect(lastEventsStr).toContain('turn_start|1');
      expect(lastEventsStr).toContain('turn_error|timeout');
    });

    it('reverse 4: fewer than 5 lines → returns all available', () => {
      const lines = [
        '2026-01-01T00:00:00Z\tevent_a\tdata1',
        '2026-01-01T00:01:00Z\tevent_b\tdata2',
      ];
      fs.writeFileSync(path.join(clawDir, 'audit.tsv'), lines.join('\n') + '\n', 'utf-8');

      const snapshot = gatherClawSnapshot(clawDir, fsFactory, mockPm, 'claw-test');

      expect(snapshot.lastAuditEvents).toHaveLength(2);
      expect(snapshot.lastAuditEvents).toEqual(lines);
    });
  });
});
