/**
 * Phase 1825 Step B: DialogStore write-only audit capability（audit-sink）。
 *
 * 无品牌、单 write 方法 sink 走真实产品路径的回归（四类）：
 * 1. DialogStore 保存 → 校验 → 重载（invariant 审计行精确断言）；
 * 2. 公开校验入口 migrateAndValidateSession / validateSessionData 的可选 audit sink；
 * 3. lookup 两条 io_error 首 exists 故障路径（结果协议与审计行精确断言）；
 * 4. performRegimeSwitch 真实流程（同一最小 sink 全程，owner 事件常量）。
 *
 * 不用 vi.mock；不用 as AuditLog / unknown / any 类型逃逸；不给 sink 加
 * brand / preview / message / summary 等伪方法。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BlockIdIndex,
  createDialogStore,
  DIALOG_AUDIT_EVENTS,
  DialogStore,
  lookupContentByBlockId,
  lookupContentByToolUseId,
  migrateAndValidateSession,
  performRegimeSwitch,
  validateSessionData,
} from '../../../src/foundation/dialog-store/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { cleanupTempDir, createTempDir } from '../../utils/temp.js';

/** existsSync 故障注入：仅覆写这一处，其余 NodeFileSystem 行为保持真实。 */
class ExistsFailureFs extends NodeFileSystem {
  override existsSync(_relativePath: string): boolean {
    throw new Error('denied');
  }
}

/** 真实最小 sink：无品牌、只有 write、write 返回 void。 */
function collectSink(rows: (string | number)[][]) {
  return {
    write(type: string, ...cols: (string | number)[]): void {
      rows.push([type, ...cols]);
    },
  };
}

describe('DialogStore write-only audit capability', () => {
  let root: string;
  beforeEach(async () => { root = await createTempDir('chestnut-test-'); });
  afterEach(async () => { await cleanupTempDir(root); });

  it('persists, validates and reloads with an unbranded write-only sink', async () => {
    const rows: (string | number)[][] = [];
    const sink = collectSink(rows);
    const fs = new NodeFileSystem({ baseDir: root });
    const store = createDialogStore(fs, '', sink, 'current.json', 'claw-a');
    await store.save({
      systemPrompt: 'system', toolsForLLM: [],
      messages: [{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }],
    });
    const loaded = await new DialogStore(fs, '', sink, 'current.json', 'claw-a').load();
    expect(loaded.source).toBe('current');
    if (loaded.source !== 'current') throw new Error('expected current snapshot');
    expect(loaded.session.systemPrompt).toBe('system');
    expect(loaded.session.messages.map(m => m.content)).toEqual(['first', 'second']);
    expect(loaded.session.toolsForLLM).toEqual([]);
    expect(rows.filter(r => r[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED)).toEqual([[
      DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED,
      'kind=consecutive_plain_user_chat', 'prev_idx=0', 'curr_idx=1', 'messages_length=2',
    ]]);
  });

  describe('public validation entries accept optional write-only sinks', () => {
    it('migrateAndValidateSession writes the exact version-unknown row and returns null', () => {
      const rows: (string | number)[][] = [];
      const sink = collectSink(rows);
      const migrated = migrateAndValidateSession({ version: 999 }, 'future.json', sink);
      expect(migrated).toBeNull();
      expect(rows).toEqual([[
        DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN,
        'file=future.json', 'actual=999', 'current=2',
      ]]);
    });

    it('validateSessionData fills the clawId fallback and keeps messages unchanged via a sink', () => {
      const rows: (string | number)[][] = [];
      const sink = collectSink(rows);
      const validated = validateSessionData({
        version: 2,
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
        systemPrompt: 'prompt',
        messages: [{ role: 'user', content: 'hello' }],
        toolsForLLM: [],
      }, sink, 'fallback-claw');
      expect(validated.clawId).toBe('fallback-claw');
      expect(validated.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(rows).toEqual([]);
    });

    it('validateSessionData stays callable with the audit argument omitted', () => {
      const validated = validateSessionData({
        version: 2,
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
        systemPrompt: 'prompt',
        messages: [{ role: 'user', content: 'hello' }],
        toolsForLLM: [],
      });
      expect(validated.version).toBe(2);
      expect(validated.clawId).toBeUndefined();
      expect(validated.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });
  });

  describe('lookup io_error paths when the first existsSync throws', () => {
    it('lookupContentByToolUseId reports io_error with the exact audit row', () => {
      const rows: (string | number)[][] = [];
      const sink = collectSink(rows);
      const fs = new ExistsFailureFs({ baseDir: root });
      const result = lookupContentByToolUseId(fs, '', 'tool-1', undefined, sink);
      expect(result).toEqual({ source: 'unavailable', reason: 'io_error', detail: ['denied'] });
      expect(rows).toEqual([[
        DIALOG_AUDIT_EVENTS.LOOKUP_IO_ERROR,
        'dir=dialog', 'toolUseId=tool-1', 'reason=denied',
      ]]);
    });

    it('lookupContentByBlockId reports io_error with its string detail and exact audit row', () => {
      const rows: (string | number)[][] = [];
      const sink = collectSink(rows);
      const fs = new ExistsFailureFs({ baseDir: root });
      const result = lookupContentByBlockId(fs, '', 'block-1', new BlockIdIndex(fs, ''), sink);
      expect(result).toEqual({ source: 'unavailable', reason: 'io_error', detail: 'denied' });
      expect(rows).toEqual([[
        DIALOG_AUDIT_EVENTS.LOOKUP_IO_ERROR,
        'dir=dialog', 'blockId=block-1', 'reason=denied',
      ]]);
    });
  });

  it('runs a real performRegimeSwitch flow on one write-only sink', async () => {
    const rows: (string | number)[][] = [];
    const sink = collectSink(rows);
    const fs = new NodeFileSystem({ baseDir: root });

    // 旧 regime：真实 store + 同一 sink，save 一条 user 消息。
    const oldStore = createDialogStore(fs, '', sink, 'current.json', 'claw-regime');
    await oldStore.save({
      systemPrompt: 'old',
      messages: [{ role: 'user', content: 'old' }],
      toolsForLLM: [],
    });

    const result = await performRegimeSwitch({
      strategy: 'all',
      newSystemPrompt: 'new',
      currentStore: oldStore,
      dialogStoreFactory: () => new DialogStore(fs, '', sink, 'current.json', 'claw-regime'),
      toolsForLLM: [],
      systemFs: fs,
      audit: sink,
    });

    expect(result.inheritedCount).toBe(1);
    expect(result.discardedCount).toBe(0);

    // 新 store 载入：prompt='new'、messages 原样继承（不依赖 brand/preview/message/summary）。
    const loaded = await result.newStore.load();
    expect(loaded.source).toBe('current');
    if (loaded.source !== 'current') throw new Error('expected current snapshot after regime switch');
    expect(loaded.session.systemPrompt).toBe('new');
    expect(loaded.session.messages).toEqual([{ role: 'user', content: 'old' }]);

    // 旧 session 已入 archive（恰好一项）。
    const archiveEntries = fs.listSync('archive');
    expect(archiveEntries.filter(e => e.isFile && e.name.endsWith('.json'))).toHaveLength(1);

    // 全程审计行精确：仅两条 regime 成功事件、列逐字匹配（owner 常量 / phase 1850 Step E）。
    expect(rows).toEqual([
      [DIALOG_AUDIT_EVENTS.REGIME_SWITCH_COMMITTED, 'strategy=all', 'inherited=1'],
      [DIALOG_AUDIT_EVENTS.REGIME_SWITCH, 'strategy=all', 'inherited=1', 'discarded=0'],
    ]);
  });
});
