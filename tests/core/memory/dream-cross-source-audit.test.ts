/**
 * phase 247 Step B + phase 280 — memory dream-state cross-source audit tests
 *
 * 覆盖保留 check（DC-3 + RC-2/3）+ save 集成。
 * phase 280: DC-1/DC-2/RC-1 已消除（高水位线改造），archive list provider 不再需。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  auditDeepDreamCrossSource,
  auditRandomDreamCrossSource,
} from '../../../src/core/memory/dream-cross-source-audit.js';
import {
  __test_saveDreamState,
  __test_DEEP_DREAM_STATE_FILE,
  type __test_DreamStateData,
} from '../../../src/core/memory/deep-dream.js';
import {
  __test_saveRandomDreamState,
  __test_RANDOM_DREAM_STATE_FILE,
} from '../../../src/core/memory/random-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFsForWrite(writeImpl?: (file: string, content: string) => void): FileSystem {
  return { writeAtomicSync: vi.fn(writeImpl ?? (() => {})) } as any;
}

describe('memory dream-state cross-source audit (phase 247 Step B + phase 280)', () => {
  describe('DC-3: retry runaway', () => {
    it('count < upper → 0 emit', () => {
      const audit = makeMockAudit();
      auditDeepDreamCrossSource(
        { currentSessionRetryCount: 2 },
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('dc3_retry_runaway'))).toBe(false);
    });

    it('count >= upper → emit dc3_retry_runaway', () => {
      const audit = makeMockAudit();
      auditDeepDreamCrossSource(
        { currentSessionRetryCount: 3 },
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH &&
        c[1]?.includes('dc3_retry_runaway')
      )).toBe(true);
    });

    it('count undefined → 0 emit (默认 0)', () => {
      const audit = makeMockAudit();
      auditDeepDreamCrossSource(
        {},
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('dc3_retry_runaway'))).toBe(false);
    });
  });

  describe('RC-2: pendingLateSettle taskId unique', () => {
    it('无 duplicate → 0 emit', () => {
      const audit = makeMockAudit();
      auditRandomDreamCrossSource(
        { pendingLateSettle: [{ taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2 }] },
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('rc2_pending_taskId_duplicate'))).toBe(false);
    });

    it('duplicate → emit rc2_duplicate', () => {
      const audit = makeMockAudit();
      auditRandomDreamCrossSource(
        {
          pendingLateSettle: [
            { taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2 },
            { taskId: 't1', scheduledAt: 3, expectedTimeoutAt: 4 },
          ],
        },
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH &&
        c[1]?.includes('rc2_pending_taskId_duplicate')
      )).toBe(true);
    });

    it('pendingLateSettle undefined → 0 emit', () => {
      const audit = makeMockAudit();
      auditRandomDreamCrossSource(
        {},
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('rc2_pending_taskId_duplicate'))).toBe(false);
    });
  });

  describe('RC-3: pendingLateSettle timing', () => {
    it('expectedTimeoutAt >= scheduledAt → 0 emit', () => {
      const audit = makeMockAudit();
      auditRandomDreamCrossSource(
        {
          pendingLateSettle: [{ taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2 }],
        },
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('rc3_pending_timing_invalid'))).toBe(false);
    });

    it('expectedTimeoutAt < scheduledAt → emit rc3_timing_invalid', () => {
      const audit = makeMockAudit();
      auditRandomDreamCrossSource(
        {
          pendingLateSettle: [{ taskId: 't1', scheduledAt: 2, expectedTimeoutAt: 1 }],
        },
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH &&
        c[1]?.includes('rc3_pending_timing_invalid')
      )).toBe(true);
    });
  });

  describe('saveDreamState 集成', () => {
    it('合法 state → 0 emit + 文件落盘', () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        lastProcessedDeepDreamAt: 0,
        currentSessionDreamedDate: '2026-05-30',
      };
      __test_saveDreamState(fs, state, audit, 'test-claw');

      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe(__test_DEEP_DREAM_STATE_FILE);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('retry runaway → emit + 文件仍落盘', () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        lastProcessedDeepDreamAt: 0,
        currentSessionDreamedDate: '2026-05-30',
        currentSessionRetryCount: 5,
      };
      __test_saveDreamState(fs, state, audit, 'test-claw');

      expect(writes).toHaveLength(1);
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('dc3_retry_runaway'))).toBe(true);
    });
  });

  describe('saveRandomDreamState 集成', () => {
    it('合法 → 0 emit + 文件落盘', () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      __test_saveRandomDreamState(fs, { completedContractIds: [] }, audit);

      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe(__test_RANDOM_DREAM_STATE_FILE);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('pending duplicate → emit + 文件仍落盘 + 保 throw on IO 错', () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite(() => { throw new Error('ENOSPC'); });
      const audit = makeMockAudit();

      expect(() => __test_saveRandomDreamState(
        fs,
        { completedContractIds: [], pendingLateSettle: [{ taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2, contractIds: ['c1'] }, { taskId: 't1', scheduledAt: 3, expectedTimeoutAt: 4, contractIds: ['c2'] }] },
        audit,
      )).toThrow('ENOSPC');

      expect(writes).toHaveLength(0);
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      const types = calls.map((c: unknown[]) => c[0]);
      expect(types).toContain(MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH);
      expect(types).toContain(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR);
    });
  });
});
