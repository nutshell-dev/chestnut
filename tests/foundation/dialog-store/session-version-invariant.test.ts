import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { parseSessionData } from '../../../src/foundation/dialog-store/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('phase 1019 r124 E fork: DialogStore version invariant', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let store: DialogStore;
  const filename = 'current.json';
  const clawId = 'test-claw';

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    store = new DialogStore(nodeFs, '', audit.audit, filename, clawId);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('rejects session.json with version > SESSION_CURRENT_VERSION and falls back to cold start', async () => {
    const badSession = {
      version: 999,
      clawId,
      createdAt: '2026-05-18T00:00:00Z',
      updatedAt: '2026-05-18T00:00:00Z',
      systemPrompt: '',
      messages: [],
      toolsForLLM: [],
    };
    await fs.writeFile(path.join(tempDir, filename), JSON.stringify(badSession), 'utf-8');

    const result = await store.load();

    // unknown version → treat as corrupt → fallback to cold start
    expect(result.source).toBe('empty');

    const unknownEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN);
    expect(unknownEvents.length).toBeGreaterThanOrEqual(1);
    expect(unknownEvents[0]).toEqual(
      expect.arrayContaining([
        DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN,
        expect.stringContaining('actual=999'),
        expect.stringContaining('current=2'),
      ]),
    );
  });

  it('v1 session (missing toolsForLLM) → migrate to v2 with audit emit VERSION_MIGRATE', async () => {
    const v1Session = {
      version: 1,
      clawId,
      createdAt: '2026-05-18T00:00:00Z',
      updatedAt: '2026-05-18T00:00:00Z',
      systemPrompt: 'v1 prompt',
      messages: [{ role: 'user' as const, content: 'hello' }],
      // toolsForLLM missing → v1 shape
    };
    await fs.writeFile(path.join(tempDir, filename), JSON.stringify(v1Session), 'utf-8');

    const result = await store.load();

    expect(result.source).toBe('current');
    expect(result.session.version).toBe(2);
    expect(result.session.toolsForLLM).toEqual([]);
    expect(result.session.systemPrompt).toBe('v1 prompt');

    const migrateEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.VERSION_MIGRATE);
    expect(migrateEvents.length).toBe(1);
    expect(migrateEvents[0]).toEqual(
      expect.arrayContaining([
        DIALOG_AUDIT_EVENTS.VERSION_MIGRATE,
        expect.stringContaining('from=1'),
        expect.stringContaining('to=2'),
      ]),
    );
  });

  it('rejects future version without toolsForLLM (does not misidentify as v1)', async () => {
    const badSession = {
      version: 999,
      clawId,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      systemPrompt: '',
      messages: [],
      // toolsForLLM intentionally absent — this MUST NOT be treated as v1→v2 migration
    };
    await fs.writeFile(path.join(tempDir, filename), JSON.stringify(badSession), 'utf-8');

    const result = await store.load();

    // unknown version takes precedence over v1 migration → cold start
    expect(result.source).toBe('empty');
    expect(result.session.createdAt).not.toBe('2026-01-01T00:00:00Z');
    expect(result.session.version).toBe(2);

    const unknownEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN);
    expect(unknownEvents.length).toBeGreaterThanOrEqual(1);
    expect(unknownEvents[0]).toEqual(
      expect.arrayContaining([
        DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN,
        expect.stringContaining('actual=999'),
        expect.stringContaining('current=2'),
      ]),
    );
  });

  it('preserves trace_id across save and load', async () => {
    await store.save({
      systemPrompt: '',
      messages: [],
      toolsForLLM: [],
      trace_id: 'trace-abc-123',
    });

    const result = await store.load();

    expect(result.session.trace_id).toBe('trace-abc-123');
  });
});

/**
 * phase 1850 Step F: 版本裁决矩阵合并 — 单一公开入口 parseSessionData。
 * future 拒绝为唯一答案；<1 / 非整数 → INVARIANT_FAILED + 回落当前版；
 * v1（缺 toolsForLLM）→ 迁移；非对象/数组 → invalid_shape rejected。
 */
describe('phase 1850 Step F: parseSessionData version adjudication matrix', () => {
  const base = {
    clawId: 'test-claw',
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
    systemPrompt: '',
    messages: [],
    toolsForLLM: [],
  };

  it('future version (> 2) → rejected future_version + VERSION_UNKNOWN row', () => {
    const audit = makeAudit();
    const outcome = parseSessionData({ ...base, version: 999 }, 'future.json', audit.audit);
    expect(outcome).toEqual({ kind: 'rejected', reason: 'future_version' });
    expect(audit.events).toEqual([[
      DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN,
      'file=future.json', 'actual=999', 'current=2',
    ]]);
  });

  it('future version without toolsForLLM → still rejected (never misidentified as v1)', () => {
    const audit = makeAudit();
    const { toolsForLLM: _omitted, ...withoutTools } = base;
    const outcome = parseSessionData({ ...withoutTools, version: 999 }, 'future.json', audit.audit);
    expect(outcome).toEqual({ kind: 'rejected', reason: 'future_version' });
    expect(audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.VERSION_MIGRATE)).toEqual([]);
    expect(audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN)).toHaveLength(1);
  });

  it('version < 1 → ok with fallback to current version + INVARIANT_FAILED row', () => {
    const audit = makeAudit();
    const outcome = parseSessionData({ ...base, version: 0 }, 'session.json', audit.audit);
    if (outcome.kind !== 'ok') throw new Error('expected ok outcome');
    expect(outcome.session.version).toBe(2);
    expect(audit.events).toEqual([[
      DIALOG_AUDIT_EVENTS.INVARIANT_FAILED,
      'field=version', 'got=0', 'fallback=2',
    ]]);
  });

  it('non-integer version → ok with fallback to current version + INVARIANT_FAILED row', () => {
    const audit = makeAudit();
    const outcome = parseSessionData({ ...base, version: 1.5 }, 'session.json', audit.audit);
    if (outcome.kind !== 'ok') throw new Error('expected ok outcome');
    expect(outcome.session.version).toBe(2);
    expect(audit.events).toEqual([[
      DIALOG_AUDIT_EVENTS.INVARIANT_FAILED,
      'field=version', 'got=1.5', 'reason=non_integer',
    ]]);
  });

  it('v1 session (missing toolsForLLM) → ok migrated to v2 + VERSION_MIGRATE row', () => {
    const audit = makeAudit();
    const { toolsForLLM: _omitted, ...v1 } = base;
    const outcome = parseSessionData({ ...v1, version: 1 }, 'v1.json', audit.audit);
    if (outcome.kind !== 'ok') throw new Error('expected ok outcome');
    expect(outcome.session.version).toBe(2);
    expect(outcome.session.toolsForLLM).toEqual([]);
    expect(audit.events).toEqual([[
      DIALOG_AUDIT_EVENTS.VERSION_MIGRATE,
      'file=v1.json', 'from=1', 'to=2',
    ]]);
  });

  it('non-object / array raw → rejected invalid_shape (no audit row)', () => {
    const audit = makeAudit();
    for (const raw of [null, undefined, 42, 'str', [{ version: 2 }]]) {
      expect(parseSessionData(raw, 'bad.json', audit.audit))
        .toEqual({ kind: 'rejected', reason: 'invalid_shape' });
    }
    expect(audit.events).toEqual([]);
  });
});
