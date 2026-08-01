/**
 * phase 1259 Step A: ClawTopology-owned claw_outbox_summary guidance codec unit tests.
 *
 * 矩阵：
 *  - encode: v1 wire 精确五字段 shape（version + summary-hash + counts + total_claws + total_msgs），
 *    不再写旧 `hash` / `failed_claws` / `incomplete`
 *  - encode: writer 前置不变量违反（incomplete / failed_claws 非空 / totals<=0 /
 *    totals 与 counts 派生不一致 / count 非正 safe integer / hash 格式错）→ throw
 *  - decode v1: 合法 → typed state（schemaVersion 归一 1 / counts key 恢复 ClawId brand）
 *  - decode legacy: 缺 version 的旧完整 production shape → 同 decode 成功
 *  - decode invalid: 错 type / 错 from / unknown version / 缺字段（v1 & legacy）/
 *    legacy hash 双源冲突 / legacy failed_claws 非 [] / legacy incomplete 非 'false' /
 *    counts 非法 JSON / 非 plain object / key 非法 claw id / value 非正 safe integer /
 *    totals 与 counts 不一致 → typed error、无 fallback
 *  - roundtrip: encode → decode 保真（按 entries 语义比较，不比 raw JSON key 顺序）
 *  - error message 安全：只含 reason/field，不回显 counts 内容
 */

import { describe, it, expect } from 'vitest';
import {
  OUTBOX_SUMMARY_GUIDANCE_SCHEMA_VERSION,
  OutboxSummaryGuidanceDecodeError,
  encodeOutboxSummaryGuidance,
  decodeOutboxSummaryGuidance,
  type OutboxSummaryGuidanceWire,
} from '../../../src/core/claw-topology/jobs/outbox-summary/guidance-state.js';
import { SUMMARY_HASH_META_KEY } from '../../../src/core/claw-topology/jobs/outbox-summary/dedup.js';
import { HASH_LEN } from '../../../src/core/claw-topology/jobs/outbox-summary/hash.js';
import type { OutboxSummaryState } from '../../../src/core/claw-topology/jobs/outbox-summary/types.js';

const VALID_HASH = 'abc123def456';

function makeState(over?: Partial<OutboxSummaryState>): OutboxSummaryState {
  return {
    counts: { clawA: 3, clawB: 1 },
    total_claws: 2,
    total_msgs: 4,
    file_set: ['clawA:m1.md', 'clawA:m2.md', 'clawA:m3.md', 'clawB:m4.md'],
    hash: VALID_HASH,
    previews: { clawA: 'hello', clawB: 'world' },
    failed_claws: [],
    incomplete: false,
    ...over,
  };
}

function v1Meta(): Record<string, string> {
  return {
    guidance_schema_version: '1',
    [SUMMARY_HASH_META_KEY]: VALID_HASH,
    counts: JSON.stringify({ clawA: 3, clawB: 1 }),
    total_claws: '2',
    total_msgs: '4',
  };
}

/** 旧完整 production shape（缺 version + 旧六字段 + summary-hash）。 */
function legacyMeta(): Record<string, string> {
  const meta = v1Meta();
  delete meta.guidance_schema_version;
  return {
    hash: VALID_HASH,
    ...meta,
    failed_claws: '[]',
    incomplete: 'false',
  };
}

function wire(meta: Record<string, string>, over?: { type?: string; from?: string }): OutboxSummaryGuidanceWire {
  return { type: over?.type ?? 'claw_outbox_summary', from: over?.from ?? 'system', meta };
}

describe('outbox-summary guidance-state codec (phase 1259)', () => {
  describe('encodeOutboxSummaryGuidance', () => {
    it('writes exact v1 wire shape: 5 fields only（无旧 hash/failed_claws/incomplete）', () => {
      const out = encodeOutboxSummaryGuidance(makeState());

      // 精确 shape（多一个 key 即失败：v1 不再重写 hash/failed_claws/incomplete）
      expect(out).toEqual({
        guidance_schema_version: '1',
        [SUMMARY_HASH_META_KEY]: VALID_HASH,
        counts: JSON.stringify({ clawA: 3, clawB: 1 }),
        total_claws: '2',
        total_msgs: '4',
      });
      expect(OUTBOX_SUMMARY_GUIDANCE_SCHEMA_VERSION).toBe('1');
      expect(out.hash).toBeUndefined();
      expect(out.failed_claws).toBeUndefined();
      expect(out.incomplete).toBeUndefined();
    });

    it('summary-hash wire key 复用 dedup 唯一 owner 常量（不复制字面）', () => {
      expect(SUMMARY_HASH_META_KEY).toBe('summary-hash');
      const out = encodeOutboxSummaryGuidance(makeState());
      expect(out[SUMMARY_HASH_META_KEY]).toBe(VALID_HASH);
    });

    it('rejects incomplete state / non-empty failed_claws（writer 前置 fail-closed 不变量）', () => {
      expect(() => encodeOutboxSummaryGuidance(makeState({ incomplete: true }))).toThrow(/incomplete/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ failed_claws: ['clawB'] }))).toThrow(/failed_claws/);
    });

    it('rejects totals <= 0 或与 counts 派生不一致', () => {
      expect(() => encodeOutboxSummaryGuidance(makeState({ total_claws: 0 }))).toThrow(/total_claws/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ total_msgs: 0 }))).toThrow(/total_msgs/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ total_claws: 3 }))).toThrow(/total_claws/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ total_msgs: 5 }))).toThrow(/total_msgs/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ counts: {}, total_claws: 0, total_msgs: 0 }))).toThrow();
    });

    it('rejects non-positive or non-integer count values / bad hash format', () => {
      expect(() => encodeOutboxSummaryGuidance(makeState({ counts: { clawA: 0 }, total_claws: 1, total_msgs: 0 }))).toThrow(/count/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ counts: { clawA: 1.5 }, total_claws: 1, total_msgs: 1.5 }))).toThrow(/count/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ counts: { clawA: Number.MAX_SAFE_INTEGER + 1 }, total_claws: 1, total_msgs: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(/count/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ hash: 'too-short' }))).toThrow(/hash/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ hash: 'ABC123DEF456' }))).toThrow(/hash/);
      expect(() => encodeOutboxSummaryGuidance(makeState({ hash: 'x'.repeat(HASH_LEN) }))).toThrow(/hash/);
    });
  });

  describe('decodeOutboxSummaryGuidance — valid', () => {
    it('v1 legal wire → typed state（counts fresh record / key 恢复 ClawId）', () => {
      const state = decodeOutboxSummaryGuidance(wire(v1Meta()));
      expect(state).toEqual({
        schemaVersion: 1,
        hash: VALID_HASH,
        counts: { clawA: 3, clawB: 1 },
        totalClaws: 2,
        totalMsgs: 4,
      });
    });

    it('legacy production shape（缺 version）→ 同 decode 成功', () => {
      const state = decodeOutboxSummaryGuidance(wire(legacyMeta()));
      expect(state).toEqual({
        schemaVersion: 1,
        hash: VALID_HASH,
        counts: { clawA: 3, clawB: 1 },
        totalClaws: 2,
        totalMsgs: 4,
      });
    });

    it('额外 metadata key 不拒绝（transport generic 扩展字段）', () => {
      const state = decodeOutboxSummaryGuidance(wire({ ...v1Meta(), trace_id: 't-1' }));
      expect(state.totalMsgs).toBe(4);
    });
  });

  describe('decodeOutboxSummaryGuidance — invalid', () => {
    it('错 type / 错 from → schema_invalid', () => {
      expect(() => decodeOutboxSummaryGuidance(wire(v1Meta(), { type: 'claw_crashed' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
      const err = catchErr(() => decodeOutboxSummaryGuidance(wire(v1Meta(), { from: 'clawA' })));
      expect(err).toBeInstanceOf(OutboxSummaryGuidanceDecodeError);
      expect(err.reason).toBe('schema_invalid');
      expect(err.field).toBe('from');
    });

    it('unknown schema version → unknown_schema_version', () => {
      const err = catchErr(() => decodeOutboxSummaryGuidance(wire({ ...v1Meta(), guidance_schema_version: '2' })));
      expect(err.reason).toBe('unknown_schema_version');
      expect(err.field).toBe('guidance_schema_version');
    });

    it('缺 required field（v1 与 legacy 同）→ schema_invalid', () => {
      for (const key of [SUMMARY_HASH_META_KEY, 'counts', 'total_claws', 'total_msgs']) {
        const v1 = v1Meta();
        delete v1[key];
        expect(() => decodeOutboxSummaryGuidance(wire(v1))).toThrowError(OutboxSummaryGuidanceDecodeError);
        const legacy = legacyMeta();
        delete legacy[key];
        expect(() => decodeOutboxSummaryGuidance(wire(legacy))).toThrowError(OutboxSummaryGuidanceDecodeError);
      }
      // legacy 独有的旧字段也必须存在（缺 version 时按完整旧 shape 解析）
      for (const key of ['hash', 'failed_claws', 'incomplete']) {
        const legacy = legacyMeta();
        delete legacy[key];
        expect(() => decodeOutboxSummaryGuidance(wire(legacy))).toThrowError(OutboxSummaryGuidanceDecodeError);
      }
    });

    it('legacy hash 双源冲突 / failed_claws 非 [] / incomplete 非 false → 拒绝（不伪装成合法 v1）', () => {
      expect(() => decodeOutboxSummaryGuidance(wire({ ...legacyMeta(), hash: 'ffffffffffff' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
      expect(() => decodeOutboxSummaryGuidance(wire({ ...legacyMeta(), failed_claws: '["clawB"]' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
      expect(() => decodeOutboxSummaryGuidance(wire({ ...legacyMeta(), failed_claws: 'not-json' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
      expect(() => decodeOutboxSummaryGuidance(wire({ ...legacyMeta(), incomplete: 'true' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('hash 格式错 → schema_invalid', () => {
      expect(() => decodeOutboxSummaryGuidance(wire({ ...v1Meta(), [SUMMARY_HASH_META_KEY]: 'nope' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('counts 非法 JSON / 非 plain object → schema_invalid', () => {
      for (const counts of ['not-json', '[]', 'null', '"s"', '3']) {
        expect(() => decodeOutboxSummaryGuidance(wire({ ...v1Meta(), counts })))
          .toThrowError(OutboxSummaryGuidanceDecodeError);
      }
    });

    it('counts key 非法 claw id / __proto__ → schema_invalid', () => {
      expect(() => decodeOutboxSummaryGuidance(wire({
        ...v1Meta(), counts: JSON.stringify({ 'bad/id': 4 }), total_claws: '1',
      }))).toThrowError(OutboxSummaryGuidanceDecodeError);
      expect(() => decodeOutboxSummaryGuidance(wire({
        ...v1Meta(), counts: '{"__proto__":4}', total_claws: '1',
      }))).toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('counts value 非正 safe integer → schema_invalid', () => {
      for (const value of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => decodeOutboxSummaryGuidance(wire({
          ...v1Meta(), counts: JSON.stringify({ clawA: value }), total_claws: '1', total_msgs: '4',
        }))).toThrowError(OutboxSummaryGuidanceDecodeError);
      }
    });

    it('totals 非正 safe integer 或与 counts 派生不一致 → schema_invalid（0/NaN 不是合法 wire）', () => {
      expect(() => decodeOutboxSummaryGuidance(wire({ ...v1Meta(), total_msgs: '0' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
      expect(() => decodeOutboxSummaryGuidance(wire({ ...v1Meta(), total_msgs: 'NaN' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
      expect(() => decodeOutboxSummaryGuidance(wire({ ...v1Meta(), total_msgs: '1.5' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
      expect(() => decodeOutboxSummaryGuidance(wire({ ...v1Meta(), total_claws: '3' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
      expect(() => decodeOutboxSummaryGuidance(wire({ ...v1Meta(), total_msgs: '5' })))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('error message 只含 reason/field，不回显 counts 内容', () => {
      const err = catchErr(() => decodeOutboxSummaryGuidance(wire({
        ...v1Meta(), counts: JSON.stringify({ 'bad/id': 4 }), total_claws: '1',
      })));
      expect(err.message).toContain('schema_invalid');
      expect(err.message).toContain('counts');
      expect(err.message).not.toContain('bad/id');
    });
  });

  describe('roundtrip', () => {
    it('encode → decode 保真（按 entries 语义比较，不比 raw JSON key 顺序）', () => {
      const state = makeState({ counts: { clawB: 2, clawA: 3 }, total_msgs: 5 });
      const decoded = decodeOutboxSummaryGuidance(wire(encodeOutboxSummaryGuidance(state) as Record<string, string>));
      expect(decoded.schemaVersion).toBe(1);
      expect(decoded.hash).toBe(state.hash);
      expect(Object.entries(decoded.counts).sort(([a], [b]) => a.localeCompare(b)))
        .toEqual([['clawA', 3], ['clawB', 2]]);
      expect(decoded.totalClaws).toBe(2);
      expect(decoded.totalMsgs).toBe(5);
    });

    it('decoded counts 是 fresh record（非 parsed object 品牌化）', () => {
      const countsRaw = JSON.stringify({ clawA: 4 });
      const decoded = decodeOutboxSummaryGuidance(wire({
        ...v1Meta(), counts: countsRaw, total_claws: '1',
      }));
      expect(decoded.counts).toEqual({ clawA: 4 });
      expect(Object.getPrototypeOf(decoded.counts)).toBe(Object.prototype);
    });
  });
});

function catchErr(fn: () => unknown): OutboxSummaryGuidanceDecodeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OutboxSummaryGuidanceDecodeError);
    return err as OutboxSummaryGuidanceDecodeError;
  }
  throw new Error('expected decode to throw');
}
