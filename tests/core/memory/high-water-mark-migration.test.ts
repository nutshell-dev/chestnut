/**
 * phase 280 — memory dream-state high-water-mark migration tests
 *
 * 覆盖 legacy schema（processedArchives / processedContractIds）→ 高水位线 silent reset + audit emit。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  __test_loadDreamState,
  __test_DEEP_DREAM_STATE_FILE,
} from '../../../src/core/memory/deep-dream.js';
import {
  __test_loadRandomDreamState,
  __test_RANDOM_DREAM_STATE_FILE,
} from '../../../src/core/memory/random-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';

function makeMockFs(contentMap: Record<string, string | Error>): FileSystem {
  const files = new Map(Object.entries(contentMap));
  return {
    readSync: vi.fn((file: string) => {
      const v = files.get(file);
      if (v instanceof Error) throw v;
      if (v === undefined) throw new FileNotFoundError(file);
      return v;
    }),
    writeAtomicSync: vi.fn(() => {}),
    // phase 1810: quarantine 语义（rename 唯一后缀），mock 随 move 同步 Map 视图
    existsSync: vi.fn((file: string) => files.has(file)),
    moveSync: vi.fn((from: string, to: string) => {
      const v = files.get(from);
      if (v === undefined) throw new FileNotFoundError(from);
      files.delete(from);
      files.set(to, v);
    }),
  } as unknown as FileSystem;
}

describe('deep-dream legacy schema migration (phase 280)', () => {
  it('legacy state 含 processedArchives → migrate to lastProcessedDeepDreamAt=0 + audit emit', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_DEEP_DREAM_STATE_FILE]: JSON.stringify({
        processedArchives: ['1717000000000_a.json', '1717000000001_b.json'],
        currentSessionDreamedDate: '2026-05-30',
      }),
    });

    const result = __test_loadDreamState(fs, audit, 'test-claw');
    expect(result.status).toBe('ready');
    const { state } = result;

    expect(state.lastProcessedDeepDreamAt).toBe(0);
    expect(state.currentSessionDreamedDate).toBe('');
    expect(state.currentSessionRetryCount).toBe(0);
    expect(state.schema_version).toBe(2);
    expect(state.pendingNotifications).toEqual([]);

    expect(audit.write).toHaveBeenCalledTimes(1);
    const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED_RESET);
    expect(call).toEqual(expect.arrayContaining([
      expect.stringMatching(/^kind=deep_dream$/),
      expect.stringMatching(/^legacy_field=processedArchives$/),
      expect.stringMatching(/^legacy_count=2$/),
    ]));
  });

  it('新 schema → 0 migration 触发 + 正常返回', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_DEEP_DREAM_STATE_FILE]: JSON.stringify({
        lastProcessedDeepDreamAt: 1717000000000,
        currentSessionDreamedDate: '2026-05-30',
      }),
    });

    const result = __test_loadDreamState(fs, audit, 'test-claw');
    expect(result.status).toBe('ready');
    const { state } = result;

    expect(state.lastProcessedDeepDreamAt).toBe(1717000000000);
    expect(state.currentSessionDreamedDate).toBe('2026-05-30');
    expect(state.schema_version).toBe(2);
    expect(state.pendingNotifications).toEqual([]);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('文件不存在 → 返默认值 0 + 0 audit', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({});

    const result = __test_loadDreamState(fs, audit, 'test-claw');
    expect(result.status).toBe('ready');
    const { state } = result;

    expect(state.lastProcessedDeepDreamAt).toBe(0);
    expect(state.currentSessionDreamedDate).toBe('');
    expect(state.schema_version).toBe(2);
    expect(state.pendingNotifications).toEqual([]);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('损坏 JSON → degraded malformed + quarantine 保留 raw（phase 1810，不再隐式 default）', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_DEEP_DREAM_STATE_FILE]: 'not-json',
    });

    const result = __test_loadDreamState(fs, audit, 'test-claw');
    expect(result.status).toBe('degraded');
    if (result.status !== 'degraded') throw new Error('expected degraded');
    if (result.degraded.cause !== 'malformed') throw new Error('expected malformed');
    expect(result.degraded.quarantine).toEqual({
      kind: 'quarantined',
      path: `${__test_DEEP_DREAM_STATE_FILE}.corrupt-1`,
    });
    // raw 原文已随 rename 保留在 quarantine 路径、canonical 不存在 → 不会被 save 覆盖
    expect(fs.existsSync(__test_DEEP_DREAM_STATE_FILE)).toBe(false);
    expect(fs.readSync(`${__test_DEEP_DREAM_STATE_FILE}.corrupt-1`)).toBe('not-json');
    expect(fs.writeAtomicSync).not.toHaveBeenCalled();
    const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
  });
});

describe('random-dream legacy schema migration (phase 925)', () => {
  it('legacy state 含 processedContractIds → migrate to completedContractIds + audit emit', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        processedContractIds: ['c1', 'c2'],
      }),
    });

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.completedContractIds).toEqual(['c1', 'c2']);
    expect(state.pendingLateSettle).toEqual([]);
    expect(state.pendingNotifications).toEqual([]);
    expect(state.schema_version).toBe(2);

    expect(audit.write).toHaveBeenCalledTimes(1);
    const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED_RESET);
    expect(call).toEqual(expect.arrayContaining([
      expect.stringMatching(/^kind=random_dream$/),
      expect.stringMatching(/^legacy_field=processedContractIds$/),
      expect.stringMatching(/^legacy_count=2$/),
    ]));
  });

  it('legacy state 含 processedContractIds + pendingLateSettle → migrate 保 pendingLateSettle', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        processedContractIds: ['c1'],
        pendingLateSettle: [
          { taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2, contractIds: ['c1'] },
          { taskId: 't2', scheduledAt: 3, expectedTimeoutAt: 4, contractIds: ['c2'] },
        ],
      }),
    });

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.completedContractIds).toEqual(['c1']);
    expect(state.pendingLateSettle).toHaveLength(2);
    expect(state.pendingLateSettle?.[0].taskId).toBe('t1');
    expect(state.pendingNotifications).toEqual([]);
    expect(state.schema_version).toBe(2);
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect((audit.write as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe(MEMORY_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED_RESET);
  });

  it('legacy state 含 lastProcessedRandomDreamAt → migrate to completedContractIds=[] + audit emit', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        lastProcessedRandomDreamAt: 1717000000000,
      }),
    });

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.completedContractIds).toEqual([]);
    expect(state.pendingNotifications).toEqual([]);
    expect(state.schema_version).toBe(2);
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect((audit.write as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe(MEMORY_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED_RESET);
  });

  it('新 schema → 0 migration 触发 + 正常返回', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        completedContractIds: ['c1'],
      }),
    });

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.completedContractIds).toEqual(['c1']);
    expect(state.pendingNotifications).toEqual([]);
    expect(state.schema_version).toBe(2);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('文件不存在 → 返默认值空数组 + 0 audit', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({});

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.completedContractIds).toEqual([]);
    expect(state.schema_version).toBe(2);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('损坏 JSON → degraded malformed + quarantine 保留 raw（phase 1810，不再隐式 default）', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: 'not-json',
    });

    const { state, degraded } = __test_loadRandomDreamState(fs, audit);

    expect(degraded?.cause).toBe('malformed');
    if (degraded?.cause !== 'malformed') throw new Error('expected malformed');
    expect(degraded.quarantine).toEqual({
      kind: 'quarantined',
      path: `${__test_RANDOM_DREAM_STATE_FILE}.corrupt-1`,
    });
    // state 仅为占位 default（caller 见 degraded 必阻断，不得 save）
    expect(state.completedContractIds).toEqual([]);
    expect(fs.existsSync(__test_RANDOM_DREAM_STATE_FILE)).toBe(false);
    expect(fs.readSync(`${__test_RANDOM_DREAM_STATE_FILE}.corrupt-1`)).toBe('not-json');
    expect(fs.writeAtomicSync).not.toHaveBeenCalled();
    const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR);
  });
});
