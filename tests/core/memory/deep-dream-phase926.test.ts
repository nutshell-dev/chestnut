/**
 * Phase 926 — deep-dream future schema guard.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  __test_loadDreamState,
  __test_DEEP_DREAM_STATE_FILE,
} from '../../../src/core/memory/deep-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

const clawId = 'test-claw';

function makeMockFs(readImpl: (file: string) => string): FileSystem {
  return { readSync: vi.fn(readImpl) } as any;
}

describe('deep-dream phase926 invariants', () => {
  describe('loadDreamState future version guard', () => {
    it('returns default state for future schema_version and keeps file on disk', () => {
      const fs = makeMockFs(() => JSON.stringify({
        schema_version: 99,
        lastProcessedDeepDreamAt: 12345,
        currentSessionDreamedDate: '2026-01-01',
      }));
      const audit = makeMockAudit();

      const state = __test_loadDreamState(fs, audit, clawId);
      expect(state).toEqual({
        schema_version: 1,
        lastProcessedDeepDreamAt: 0,
        currentSessionDreamedDate: '',
        currentSessionRetryCount: 0,
      });
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION);
      expect(call).toEqual(expect.arrayContaining([
        expect.stringMatching(/^version=99$/),
        expect.stringMatching(/^current=1$/),
        expect.stringMatching(/^clawId=test-claw$/),
        expect.stringMatching(/^reason=cannot_migrate_future_version$/),
      ]));
      // No write occurred — future-version file is preserved on disk.
      expect(fs.writeAtomicSync).toBeUndefined();
    });
  });
});
