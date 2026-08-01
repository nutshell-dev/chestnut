/**
 * phase 1257 Step A: Watchdog-owned claw_crashed guidance codec unit tests.
 *
 * 矩阵：
 *  - encode: v1 wire 精确 shape（含 version / 5 owned fields / 无 claw_id）
 *  - decode v1: 合法 → typed state（schemaVersion 归一 1）
 *  - decode legacy: 缺 version 的旧 production shape → 同 decode 成功
 *  - decode invalid: unknown version / unknown class / 坏 boolean / 坏 count /
 *    坏 ISO / 缺字段 / 空 from / 错 type → typed error、无 fallback
 *  - roundtrip: encode → decode 保真
 */

import { describe, it, expect } from 'vitest';
import {
  CLAW_CRASHED_GUIDANCE_SCHEMA_VERSION,
  ClawCrashedGuidanceDecodeError,
  encodeClawCrashedGuidance,
  decodeClawCrashedGuidance,
  type ClawCrashedGuidanceWire,
} from '../../src/watchdog/claw-crashed-guidance.js';

const VALID_AS_OF = '2026-08-01T12:34:56.789Z';

function v1Meta(): Record<string, string> {
  return {
    guidance_schema_version: '1',
    crash_class: 'active_unexpected',
    clean_stop_marker: 'false',
    contract: 'active:c1',
    outbox_pending: '3',
    as_of: VALID_AS_OF,
  };
}

function legacyMeta(): Record<string, string> {
  const meta = v1Meta();
  delete meta.guidance_schema_version;
  return meta;
}

function wire(meta: Record<string, string>, over?: { type?: string; from?: string }): ClawCrashedGuidanceWire {
  return { type: over?.type ?? 'claw_crashed', from: over?.from ?? 'claw-a', meta };
}

describe('claw-crashed-guidance codec (phase 1257)', () => {
  describe('encodeClawCrashedGuidance', () => {
    it('writes exact v1 wire shape: version + 5 owned fields, source = clawId, no claw_id key', () => {
      const out = encodeClawCrashedGuidance({
        clawId: 'claw-a',
        crashClass: 'active_user_stopped',
        cleanStopMarker: true,
        contract: 'active:c1',
        outboxPending: 3,
        asOf: VALID_AS_OF,
      });

      expect(out.source).toBe('claw-a');
      // 精确 shape（多一个 key 即失败，含 claw_id 双源防护）
      expect(out.extraFields).toEqual({
        guidance_schema_version: '1',
        crash_class: 'active_user_stopped',
        clean_stop_marker: 'true',
        contract: 'active:c1',
        outbox_pending: '3',
        as_of: VALID_AS_OF,
      });
    });

    it('accepts -1 outboxPending sentinel (production gatherClawSnapshot read-failure reality)', () => {
      const out = encodeClawCrashedGuidance({
        clawId: 'claw-a',
        crashClass: 'active_unexpected',
        cleanStopMarker: false,
        contract: 'active:c1',
        outboxPending: -1,
        asOf: VALID_AS_OF,
      });
      expect(out.extraFields.outbox_pending).toBe('-1');
    });

    it('rejects empty clawId / non-integer outboxPending / non-ISO asOf', () => {
      const base = {
        clawId: 'claw-a',
        crashClass: 'active_unexpected' as const,
        cleanStopMarker: false,
        contract: 'active:c1',
        outboxPending: 0,
        asOf: VALID_AS_OF,
      };
      expect(() => encodeClawCrashedGuidance({ ...base, clawId: '' })).toThrow(/clawId/);
      expect(() => encodeClawCrashedGuidance({ ...base, outboxPending: 1.5 })).toThrow(/outboxPending/);
      expect(() => encodeClawCrashedGuidance({ ...base, asOf: 'not a date' })).toThrow(/asOf/);
    });
  });

  describe('decodeClawCrashedGuidance — valid', () => {
    it('v1 legal wire → typed camelCase state', () => {
      const state = decodeClawCrashedGuidance(wire(v1Meta()));
      expect(state).toEqual({
        schemaVersion: 1,
        clawId: 'claw-a',
        crashClass: 'active_unexpected',
        cleanStopMarker: false,
        contract: 'active:c1',
        outboxPending: 3,
        asOf: VALID_AS_OF,
      });
    });

    it('legacy production shape (no version) decodes to same state (schemaVersion normalized to 1)', () => {
      const state = decodeClawCrashedGuidance(wire(legacyMeta()));
      expect(state).toEqual({
        schemaVersion: 1,
        clawId: 'claw-a',
        crashClass: 'active_unexpected',
        cleanStopMarker: false,
        contract: 'active:c1',
        outboxPending: 3,
        asOf: VALID_AS_OF,
      });
    });

    it('legacy -1 outbox_pending (production read-failure sentinel) decodes', () => {
      const state = decodeClawCrashedGuidance(wire({ ...legacyMeta(), outbox_pending: '-1' }));
      expect(state.outboxPending).toBe(-1);
    });

    it('extra transport metadata keys are ignored, not rejected', () => {
      const state = decodeClawCrashedGuidance(wire({ ...v1Meta(), trace_id: 't-1', extra_unknown: 'x' }));
      expect(state.clawId).toBe('claw-a');
    });

    it('roundtrip: encode → decode preserves all fields', () => {
      const input = {
        clawId: 'claw-round',
        crashClass: 'active_user_stopped' as const,
        cleanStopMarker: true,
        contract: 'active:c9',
        outboxPending: 42,
        asOf: VALID_AS_OF,
      };
      const encoded = encodeClawCrashedGuidance(input);
      const state = decodeClawCrashedGuidance({
        type: 'claw_crashed',
        from: encoded.source,
        meta: encoded.extraFields,
      });
      expect(state).toEqual({ schemaVersion: 1, ...input });
    });
  });

  describe('decodeClawCrashedGuidance — invalid (typed error, no fallback)', () => {
    it('unknown schema version → unknown_schema_version', () => {
      let caught: unknown;
      try {
        decodeClawCrashedGuidance(wire({ ...v1Meta(), guidance_schema_version: '2' }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ClawCrashedGuidanceDecodeError);
      expect((caught as ClawCrashedGuidanceDecodeError).reason).toBe('unknown_schema_version');
      expect((caught as ClawCrashedGuidanceDecodeError).field).toBe('guidance_schema_version');
    });

    it('wrong type → schema_invalid', () => {
      expect(() => decodeClawCrashedGuidance(wire(v1Meta(), { type: 'claw_inactivity' })))
        .toThrowError(ClawCrashedGuidanceDecodeError);
    });

    it('empty from → schema_invalid (no placeholder fallback)', () => {
      let caught: unknown;
      try {
        decodeClawCrashedGuidance(wire(v1Meta(), { from: '' }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ClawCrashedGuidanceDecodeError);
      expect((caught as ClawCrashedGuidanceDecodeError).reason).toBe('schema_invalid');
    });

    it.each([
      ['unknown crash class', { crash_class: 'mystery' }, 'crash_class'],
      ['bad boolean', { clean_stop_marker: 'yes' }, 'clean_stop_marker'],
      ['non-integer count', { outbox_pending: '1.5' }, 'outbox_pending'],
      ['non-numeric count', { outbox_pending: 'abc' }, 'outbox_pending'],
      ['fuzzy date (Date.parse would accept)', { as_of: 'August 1, 2026' }, 'as_of'],
      ['non-ISO as_of', { as_of: '2026/08/01 12:00' }, 'as_of'],
      ['missing crash_class', { crash_class: undefined }, 'crash_class'],
      ['missing clean_stop_marker', { clean_stop_marker: undefined }, 'clean_stop_marker'],
      ['missing contract', { contract: undefined }, 'contract'],
      ['missing outbox_pending', { outbox_pending: undefined }, 'outbox_pending'],
      ['missing as_of', { as_of: undefined }, 'as_of'],
    ])('%s → schema_invalid field=%s (v1 and legacy alike)', (_name, patch, field) => {
      for (const base of [v1Meta(), legacyMeta()]) {
        const meta: Record<string, string> = { ...base };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete meta[k];
          else meta[k] = v as string;
        }
        let caught: unknown;
        try {
          decodeClawCrashedGuidance(wire(meta));
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ClawCrashedGuidanceDecodeError);
        expect((caught as ClawCrashedGuidanceDecodeError).reason).toBe('schema_invalid');
        expect((caught as ClawCrashedGuidanceDecodeError).field).toBe(field);
      }
    });

    it('error message carries type/field/reason only, never echoes metadata or body', () => {
      let caught: unknown;
      try {
        decodeClawCrashedGuidance(wire({ ...v1Meta(), crash_class: 'mystery', contract: 'active:secret-contract' }));
      } catch (e) {
        caught = e;
      }
      const msg = (caught as Error).message;
      expect(msg).toContain('schema_invalid');
      expect(msg).toContain('crash_class');
      expect(msg).not.toContain('secret-contract');
      expect(msg).not.toContain('mystery');
    });
  });

  it('CLAW_CRASHED_GUIDANCE_SCHEMA_VERSION is the v1 wire constant', () => {
    expect(CLAW_CRASHED_GUIDANCE_SCHEMA_VERSION).toBe('1');
  });
});
