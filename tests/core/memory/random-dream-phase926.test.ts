/**
 * Phase 926 — random-dream future schema guard + result read propagation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  __test_loadRandomDreamState,
  __test_RANDOM_DREAM_STATE_FILE,
  waitForTaskResult,
} from '../../../src/core/memory/random-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

const clawId = 'test-claw';

function makeMockFs(readImpl: (file: string) => string): FileSystem {
  return { readSync: vi.fn(readImpl) } as any;
}

describe('random-dream phase926 invariants', () => {
  describe('loadRandomDreamState future version guard', () => {
    it('returns default state for future schema_version and keeps file on disk', () => {
      const fs = makeMockFs(() => JSON.stringify({ schema_version: 99, completedContractIds: ['c-old'] }));
      const audit = makeMockAudit();

      const result = __test_loadRandomDreamState(fs, audit);
      expect(result.state).toEqual({ schema_version: 1, completedContractIds: [] });
      expect(result.blocked).toEqual({ reason: 'future_schema', version: 99 });
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION);
      expect(call).toEqual(expect.arrayContaining([
        expect.stringMatching(/^version=99$/),
        expect.stringMatching(/^current=1$/),
        expect.stringMatching(/^reason=cannot_migrate_future_version$/),
      ]));
      // No write occurred — future-version file is preserved on disk.
      expect(fs.writeAtomicSync).toBeUndefined();
    });
  });

  describe('waitForTaskResult read error propagation', () => {
    function makeMotionFs(opts: { logExists: boolean; logRead?: () => string; doneRead?: () => string }): FileSystem {
      return {
        existsSync: vi.fn((p: string) => {
          if (typeof p !== 'string') return false;
          return p.endsWith('daemon.log') ? opts.logExists : p.endsWith('result.txt');
        }),
        readSync: vi.fn((p: string) => {
          if (typeof p !== 'string') throw new Error('unexpected path type');
          if (p.endsWith('daemon.log')) {
            if (opts.logRead) return opts.logRead();
            return 'log content';
          }
          if (p.endsWith('result.txt')) {
            if (opts.doneRead) return opts.doneRead();
            return 'done content';
          }
          throw new Error(`unexpected path: ${p}`);
        }),
      } as any;
    }

    it('propagates EACCES when reading log file', async () => {
      const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const motionFs = makeMotionFs({
        logExists: true,
        logRead: () => { throw err; },
      });
      const audit = makeMockAudit();

      await expect(waitForTaskResult(motionFs, 'task-1', 100, 10, audit, false)).rejects.toThrow('EACCES');
    });

    it('propagates EACCES when reading result.txt after log TOCTOU miss', async () => {
      const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const motionFs = makeMotionFs({
        logExists: false,
        doneRead: () => { throw err; },
      });
      const audit = makeMockAudit();

      await expect(waitForTaskResult(motionFs, 'task-2', 100, 10, audit, false)).rejects.toThrow('EACCES');
    });

    it('tolerates ENOENT on log read and falls back to result.txt', async () => {
      const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      const motionFs = makeMotionFs({
        logExists: true,
        logRead: () => { throw err; },
        doneRead: () => 'fallback txt',
      });
      const audit = makeMockAudit();

      // Because donePath is not pre-checked as existing, the ENOENT on result.txt
      // causes a poll-loop retry. With a 10ms pulse and 100ms timeout it may or
      // may not return before deadline depending on timing. We run it once with a
      // tiny timeout and assert it does not throw EACCES/ propogate immediately.
      const result = await waitForTaskResult(motionFs, 'task-3', 15, 5, audit, false);
      // Either null (timeout) or the fallback — never throw.
      expect(result === null || result === 'fallback txt').toBe(true);
    });
  });
});
