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
      expect(clawStateAPI.clawPreviouslyAlive.size).toBe(0);
      expect(clawStateAPI.everSpawned.size).toBe(0);
    });
  });
});

