/**
 * Phase 1159 Step B — Random Dream state v2 outbox schema
 *
 * 覆盖：
 * - v1 load 迁移为 v2 + empty outbox
 * - v2 roundtrip 保留 pendingNotifications
 * - invalid entry 过滤（resilient load）
 * - future schema 继续 blocked
 * - save 总写 schema_version=2
 */

import { describe, it, expect, vi } from 'vitest';
import {
  __test_loadRandomDreamState,
  __test_saveRandomDreamState,
  __test_RANDOM_DREAM_STATE_FILE,
  type __test_RandomDreamState,
} from '../../../src/core/memory/random-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';

function makeMockFs(contentMap: Record<string, string | Error>): FileSystem {
  return {
    readSync: vi.fn((file: string) => {
      const v = contentMap[file];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new FileNotFoundError(file);
      return v;
    }),
    writeAtomicSync: vi.fn(() => {}),
  } as unknown as FileSystem;
}

describe('random-dream state v2 (phase 1159 Step B)', () => {
  it('v1 state 迁移为 v2 + empty pendingNotifications', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        schema_version: 1,
        completedContractIds: ['c1'],
        pendingLateSettle: [{ taskId: 't1', scheduledAt: 1, expectedTimeoutAt: 2, contractIds: ['c1'] }],
      }),
    });

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.schema_version).toBe(2);
    expect(state.completedContractIds).toEqual(['c1']);
    expect(state.pendingLateSettle).toHaveLength(1);
    expect(state.pendingNotifications).toEqual([]);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('legacy 无 schema_version 迁移为 v2 + empty pendingNotifications', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        completedContractIds: ['c1'],
      }),
    });

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.schema_version).toBe(2);
    expect(state.pendingNotifications).toEqual([]);
  });

  it('v2 roundtrip 保留 pendingNotifications', () => {
    const audit = makeMockAudit();
    const notification = {
      deliveryId: 'random-dream:task-1',
      taskId: 'task-1',
      outputPath: 'memory/dream-outputs/task-1.txt',
      outputCount: 2,
      completedContractIds: ['c1', 'c2'],
      createdAt: 1717000000000,
    };
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        schema_version: 2,
        completedContractIds: ['c1'],
        pendingNotifications: [notification],
      }),
    });

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.pendingNotifications).toHaveLength(1);
    expect(state.pendingNotifications?.[0]).toEqual(notification);
  });

  it('invalid pendingNotifications entry 过滤并 audit', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        schema_version: 2,
        completedContractIds: [],
        pendingNotifications: [
          {
            deliveryId: 'random-dream:valid',
            taskId: 'valid',
            outputPath: 'memory/dream-outputs/valid.txt',
            outputCount: 1,
            completedContractIds: ['c1'],
            createdAt: 1717000000000,
          },
          { deliveryId: 42, outputCount: -1 }, // invalid
        ],
      }),
    });

    const { state } = __test_loadRandomDreamState(fs, audit);

    expect(state.pendingNotifications).toHaveLength(1);
    expect(state.pendingNotifications?.[0].deliveryId).toBe('random-dream:valid');
    expect(audit.write).toHaveBeenCalledWith(
      MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR,
      'site=load_state',
      'reason=pending_notifications_entry_invalid_filtered',
      'before=2',
      'after=1',
    );
  });

  it('future schema 继续 blocked', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_RANDOM_DREAM_STATE_FILE]: JSON.stringify({
        schema_version: 99,
        completedContractIds: ['c1'],
      }),
    });

    const { state, blocked } = __test_loadRandomDreamState(fs, audit);

    expect(blocked).toEqual({ reason: 'future_schema', version: 99 });
    expect(state.schema_version).toBe(2);
    expect(state.completedContractIds).toEqual([]);
    expect(audit.write).toHaveBeenCalledWith(
      MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION,
      'version=99',
      'current=2',
      'reason=cannot_migrate_future_version',
    );
  });

  it('save 总写 schema_version=2（不被旧 spread 覆盖）', () => {
    const writes: Array<[string, string]> = [];
    const fs = {
      writeAtomicSync: vi.fn((file: string, content: string) => { writes.push([file, content]); }),
    } as unknown as FileSystem;
    const audit = makeMockAudit();

    const state: __test_RandomDreamState = {
      schema_version: 1, // 旧版本不应最终落盘
      completedContractIds: ['c1'],
      pendingNotifications: [{
        deliveryId: 'random-dream:task-1',
        taskId: 'task-1',
        outputPath: 'memory/dream-outputs/task-1.txt',
        outputCount: 1,
        completedContractIds: ['c1'],
        createdAt: 1717000000000,
      }],
    };
    __test_saveRandomDreamState(fs, state, audit);

    expect(writes).toHaveLength(1);
    const saved = JSON.parse(writes[0][1]);
    expect(saved.schema_version).toBe(2);
    expect(saved.pendingNotifications).toHaveLength(1);
  });

  it('save 非法 pendingNotifications 仍落盘 + audit emit', () => {
    const writes: Array<[string, string]> = [];
    const fs = {
      writeAtomicSync: vi.fn((file: string, content: string) => { writes.push([file, content]); }),
    } as unknown as FileSystem;
    const audit = makeMockAudit();

    const state = {
      completedContractIds: [],
      pendingNotifications: 'bad',
    } as unknown as __test_RandomDreamState;
    __test_saveRandomDreamState(fs, state, audit);

    expect(writes).toHaveLength(1);
    const saved = JSON.parse(writes[0][1]);
    expect(saved.schema_version).toBe(2);
    expect(audit.write).toHaveBeenCalled();
  });
});
