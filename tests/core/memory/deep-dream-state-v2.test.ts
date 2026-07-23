/**
 * Phase 1162 Step B — Deep Dream state v2 with durable notification outbox.
 *
 * Coverage:
 * - migration from v1 / legacy / missing → v2 empty outbox
 * - roundtrip save → load preserves pending notifications
 * - invalid pending entries are filtered on load
 * - future schema remains blocked (phase 1161)
 * - saveDreamState returns true/false without throwing
 */

import { describe, it, expect, vi } from 'vitest';
import {
  __test_loadDreamState,
  __test_saveDreamState,
  __test_DEEP_DREAM_STATE_FILE,
  type __test_DreamStateData,
} from '../../../src/core/memory/deep-dream.js';
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

describe('deep-dream state v2 (phase 1162 Step B)', () => {
  const clawId = 'test-claw';

  it('v1 state without pendingNotifications normalizes to v2 empty outbox', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_DEEP_DREAM_STATE_FILE]: JSON.stringify({
        schema_version: 1,
        lastProcessedDeepDreamAt: 1717000000000,
        currentSessionDreamedDate: '2026-05-30',
      }),
    });

    const result = __test_loadDreamState(fs, audit, clawId);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');

    expect(result.state.schema_version).toBe(2);
    expect(result.state.lastProcessedDeepDreamAt).toBe(1717000000000);
    expect(result.state.currentSessionDreamedDate).toBe('2026-05-30');
    expect(result.state.pendingNotifications).toEqual([]);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('legacy processedArchives migrates to v2 empty outbox', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_DEEP_DREAM_STATE_FILE]: JSON.stringify({
        processedArchives: ['1717000000000_a.json'],
        currentSessionDreamedDate: '2026-05-30',
      }),
    });

    const result = __test_loadDreamState(fs, audit, clawId);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');

    expect(result.state.schema_version).toBe(2);
    expect(result.state.pendingNotifications).toEqual([]);
  });

  it('missing state file returns v2 default empty outbox', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({});

    const result = __test_loadDreamState(fs, audit, clawId);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');

    expect(result.state.schema_version).toBe(2);
    expect(result.state.pendingNotifications).toEqual([]);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('roundtrip save → load preserves pending notifications', () => {
    const audit = makeMockAudit();
    const writes: Array<[string, string]> = [];
    const fs = {
      readSync: vi.fn(() => { throw new FileNotFoundError(__test_DEEP_DREAM_STATE_FILE); }),
      writeAtomicSync: vi.fn((file: string, content: string) => { writes.push([file, content]); }),
    } as unknown as FileSystem;

    const state: __test_DreamStateData = {
      lastProcessedDeepDreamAt: 1717000000000,
      currentSessionDreamedDate: '2026-05-30',
      pendingNotifications: [
        { deliveryId: 'deep-dream:test-claw:0:none:abc123', body: 'dream body', sessionCount: 1, createdAt: 1717000000000 },
      ],
    };

    const saved = __test_saveDreamState(fs, state, audit, clawId);
    expect(saved).toBe(true);
    expect(writes).toHaveLength(1);

    const savedJson = JSON.parse(writes[0][1]);
    expect(savedJson.schema_version).toBe(2);
    expect(savedJson.pendingNotifications).toHaveLength(1);
    expect(savedJson.pendingNotifications[0].body).toBe('dream body');
  });

  it('load filters invalid pending entries and emits audit', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_DEEP_DREAM_STATE_FILE]: JSON.stringify({
        lastProcessedDeepDreamAt: 0,
        currentSessionDreamedDate: '',
        pendingNotifications: [
          { deliveryId: 'valid', body: 'ok', sessionCount: 1, createdAt: 1 },
          { deliveryId: 'invalid', body: 123, sessionCount: 'one', createdAt: null },
          'not-an-object',
        ],
      }),
    });

    const result = __test_loadDreamState(fs, audit, clawId);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');

    expect(result.state.pendingNotifications).toHaveLength(1);
    expect(result.state.pendingNotifications?.[0].deliveryId).toBe('valid');

    expect(audit.write).toHaveBeenCalledTimes(1);
    const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
    expect(call).toEqual(expect.arrayContaining([
      expect.stringMatching(/^step=load_state$/),
      expect.stringMatching(/^reason=pending_notifications_entry_invalid_filtered$/),
      expect.stringMatching(/^before=3$/),
      expect.stringMatching(/^after=1$/),
    ]));
  });

  it('future schema_version stays blocked and does not normalize', () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      [__test_DEEP_DREAM_STATE_FILE]: JSON.stringify({
        schema_version: 99,
        lastProcessedDeepDreamAt: 12345,
        currentSessionDreamedDate: '2099-01-01',
        pendingNotifications: [{ deliveryId: 'x', body: 'y', sessionCount: 1, createdAt: 1 }],
      }),
    });

    const result = __test_loadDreamState(fs, audit, clawId);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('expected blocked');
    expect(result.reason).toBe('future_schema');
    expect(result.version).toBe(99);
    expect(fs.writeAtomicSync).not.toHaveBeenCalled();
  });

  it('saveDreamState returns true on successful write', () => {
    const audit = makeMockAudit();
    const fs = { writeAtomicSync: vi.fn(() => {}) } as unknown as FileSystem;

    const result = __test_saveDreamState(fs, {
      lastProcessedDeepDreamAt: 0,
      currentSessionDreamedDate: '',
    }, audit, clawId);

    expect(result).toBe(true);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('saveDreamState returns false and audits on write failure without throwing', () => {
    const audit = makeMockAudit();
    const fs = { writeAtomicSync: vi.fn(() => { throw new Error('ENOSPC'); }) } as unknown as FileSystem;

    const result = __test_saveDreamState(fs, {
      lastProcessedDeepDreamAt: 0,
      currentSessionDreamedDate: '',
    }, audit, clawId);

    expect(result).toBe(false);
    expect(audit.write).toHaveBeenCalledTimes(1);
    const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
    expect(call).toEqual(expect.arrayContaining([
      expect.stringMatching(/^step=save_state$/),
      expect.stringMatching(/^reason=.*ENOSPC/),
    ]));
  });
});
