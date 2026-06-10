/**
 * phase 247 Step B — memory dream-state cross-source audit tests
 *
 * 覆盖 6 check（DC-1/2/3 + RC-1/2/3）+ archive list 失败降级 + save 集成 + fire-and-forget。
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { writeAtomicSync: vi.fn(writeImpl ?? (() => {})) } as any;
}

describe('memory dream-state cross-source audit (phase 247 Step B)', () => {
  describe('DC-1: processedArchives ⊆ listArchives', () => {
    it('完全 subset → 0 emit', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: ['a.json', 'b.json'] },
        async () => ['a.json', 'b.json', 'c.json'],
        audit,
      );
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('processed 含 1 orphan → emit dc1_orphan + ids', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: ['a.json', 'orphan.json'] },
        async () => ['a.json'],
        audit,
      );
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH);
      expect(call[1]).toContain('dc1_processedArchives_orphan');
      expect(call).toEqual(expect.arrayContaining([
        expect.stringContaining('orphan_count=1'),
      ]));
    });

    it('processed=空 + archives 非空 → 0 emit（空集 ⊆ 任何集）', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: [] },
        async () => ['a.json'],
        audit,
      );
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('DC-2: processedArchives unique', () => {
    it('无重复 → 0 emit', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: ['a.json', 'b.json'] },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('dc2_processedArchives_duplicate'))).toBe(false);
    });

    it('1 个重复 → emit dc2_duplicate', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: ['a.json', 'a.json', 'b.json'] },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH &&
        c[1]?.includes('dc2_processedArchives_duplicate')
      )).toBe(true);
    });
  });

  describe('DC-3: retry runaway', () => {
    it('count < upper → 0 emit', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: [], currentSessionRetryCount: 2 },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('dc3_retry_runaway'))).toBe(false);
    });

    it('count >= upper → emit dc3_retry_runaway', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: [], currentSessionRetryCount: 3 },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH &&
        c[1]?.includes('dc3_retry_runaway')
      )).toBe(true);
    });

    it('count undefined → 0 emit (默认 0)', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: [] },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('dc3_retry_runaway'))).toBe(false);
    });
  });

  describe('RC-1: processedContractIds ⊆ archive', () => {
    it('完全 subset → 0 emit', async () => {
      const audit = makeMockAudit();
      await auditRandomDreamCrossSource(
        { processedContractIds: ['c1', 'c2'] },
        async () => ['c1', 'c2', 'c3'],
        audit,
      );
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('1 orphan → emit rc1_orphan', async () => {
      const audit = makeMockAudit();
      await auditRandomDreamCrossSource(
        { processedContractIds: ['c1', 'orphan'] },
        async () => ['c1'],
        audit,
      );
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH);
      expect(call[1]).toContain('rc1_processedContractIds_orphan');
    });
  });

  describe('RC-2: pendingLateSettle taskId unique', () => {
    it('无 duplicate → 0 emit', async () => {
      const audit = makeMockAudit();
      await auditRandomDreamCrossSource(
        { processedContractIds: [], pendingLateSettle: [{ taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2 }] },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('rc2_pending_taskId_duplicate'))).toBe(false);
    });

    it('duplicate → emit rc2_duplicate', async () => {
      const audit = makeMockAudit();
      await auditRandomDreamCrossSource(
        {
          processedContractIds: [],
          pendingLateSettle: [
            { taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2 },
            { taskId: 't1', scheduledAt: 3, expectedTimeoutAt: 4 },
          ],
        },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH &&
        c[1]?.includes('rc2_pending_taskId_duplicate')
      )).toBe(true);
    });

    it('pendingLateSettle undefined → 0 emit', async () => {
      const audit = makeMockAudit();
      await auditRandomDreamCrossSource(
        { processedContractIds: [] },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('rc2_pending_taskId_duplicate'))).toBe(false);
    });
  });

  describe('RC-3: pendingLateSettle timing', () => {
    it('expectedTimeoutAt >= scheduledAt → 0 emit', async () => {
      const audit = makeMockAudit();
      await auditRandomDreamCrossSource(
        {
          processedContractIds: [],
          pendingLateSettle: [{ taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2 }],
        },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('rc3_pending_timing_invalid'))).toBe(false);
    });

    it('expectedTimeoutAt < scheduledAt → emit rc3_timing_invalid', async () => {
      const audit = makeMockAudit();
      await auditRandomDreamCrossSource(
        {
          processedContractIds: [],
          pendingLateSettle: [{ taskId: 't1', scheduledAt: 2, expectedTimeoutAt: 1 }],
        },
        async () => [],
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH &&
        c[1]?.includes('rc3_pending_timing_invalid')
      )).toBe(true);
    });
  });

  describe('listArchives 失败降级', () => {
    it('listArchives throw → emit dc1_skip + DC-2/3 仍跑', async () => {
      const audit = makeMockAudit();
      await auditDeepDreamCrossSource(
        { processedArchives: ['a.json', 'a.json'], currentSessionRetryCount: 5 },
        async () => { throw new Error('disk fail'); },
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_SKIPPED &&
        c[1]?.includes('deep_dc1_skip')
      )).toBe(true);
      // DC-2 and DC-3 still ran
      expect(calls.some(c => c[1]?.includes('dc2_processedArchives_duplicate'))).toBe(true);
      expect(calls.some(c => c[1]?.includes('dc3_retry_runaway'))).toBe(true);
    });

    it('listArchiveContractIds throw → emit rc1_skip + RC-2/3 仍跑', async () => {
      const audit = makeMockAudit();
      await auditRandomDreamCrossSource(
        {
          processedContractIds: [],
          pendingLateSettle: [
            { taskId: 't1', scheduledAt: 2, expectedTimeoutAt: 1 },
          ],
        },
        async () => { throw new Error('disk fail'); },
        audit,
      );
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c =>
        c[0] === MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_SKIPPED &&
        c[1]?.includes('random_rc1_skip')
      )).toBe(true);
      // RC-3 still ran
      expect(calls.some(c => c[1]?.includes('rc3_pending_timing_invalid'))).toBe(true);
    });
  });

  describe('saveDreamState 集成', () => {
    it('合法 state + 合法 archives → 0 emit + 文件落盘', async () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        processedArchives: ['x.json'],
        currentSessionDreamedDate: '2026-05-30',
      };
      __test_saveDreamState(fs, state, audit, 'test-claw', async () => ['x.json']);

      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe(__test_DEEP_DREAM_STATE_FILE);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('orphan + duplicate state → emit + 文件仍落盘（F36）', async () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        processedArchives: ['x.json', 'x.json', 'orphan.json'],
        currentSessionDreamedDate: '2026-05-30',
      };
      __test_saveDreamState(fs, state, audit, 'test-claw', async () => ['x.json']);

      expect(writes).toHaveLength(1);
      // fire-and-forget: audit emit may be async, wait a tick
      await new Promise(r => setTimeout(r, 10));
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(c => c[1]?.includes('dc1_processedArchives_orphan'))).toBe(true);
      expect(calls.some(c => c[1]?.includes('dc2_processedArchives_duplicate'))).toBe(true);
    });

    it('未传 listArchives 参数 → skip cross-source + Step A schema 仍跑', async () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        processedArchives: ['x.json'],
        currentSessionDreamedDate: '2026-05-30',
      };
      __test_saveDreamState(fs, state, audit, 'test-claw');

      expect(writes).toHaveLength(1);
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('saveRandomDreamState 集成', () => {
    it('合法 → 0 emit + 文件落盘', async () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      __test_saveRandomDreamState(fs, { processedContractIds: ['c1'] }, audit, async () => ['c1']);

      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe(__test_RANDOM_DREAM_STATE_FILE);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('mismatch state → emit + 文件仍落盘 + 保 throw on IO 错', async () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite(() => { throw new Error('ENOSPC'); });
      const audit = makeMockAudit();

      expect(() => __test_saveRandomDreamState(
        fs,
        { processedContractIds: ['c1', 'orphan'] },
        audit,
        async () => ['c1'],
      )).toThrow('ENOSPC');

      expect(writes).toHaveLength(0);
      await new Promise(r => setTimeout(r, 10));
      const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
      const types = calls.map((c: unknown[]) => c[0]);
      expect(types).toContain(MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH);
      expect(types).toContain(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR);
    });
  });

  describe('fire-and-forget 模式', () => {
    it('cross-source audit throw → 主路径不 throw、不阻 save', async () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        processedArchives: [],
        currentSessionDreamedDate: '',
      };
      expect(() => __test_saveDreamState(
        fs, state, audit, 'test-claw',
        async () => { throw new Error('boom'); },
      )).not.toThrow();

      expect(writes).toHaveLength(1);
    });
  });
});
