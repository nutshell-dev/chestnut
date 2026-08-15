/**
 * phase 1258 Step A: Watchdog-owned claw_inactivity guidance codec unit tests.
 *
 * 矩阵：
 *  - encode: v1 wire 精确 shape（含 version / 6 owned required fields / source 固定 watchdog 不入 wire）
 *  - encode: optional 字段仅在有值时写入（sourcePath / lastError）
 *  - decode v1: 合法 → typed state（schemaVersion 归一 1）
 *  - decode legacy: 缺 version 的旧 production shape → 同 decode 成功
 *  - decode invalid: unknown version / unknown class / 错 type / 错 from / 空 claw_id /
 *    坏 number / 坏 ISO / 非法 source_path / 空 optional / 缺字段 → typed error、无 fallback
 *  - roundtrip: encode → decode 保真（timeout 与 subscription 两 dialect）
 */

import { describe, it, expect } from 'vitest';
import {
  CLAW_INACTIVITY_GUIDANCE_SCHEMA_VERSION,
  ClawInactivityGuidanceDecodeError,
  encodeClawInactivityGuidance,
  decodeClawInactivityGuidance,
  type ClawInactivityGuidanceWire,
} from '../../src/watchdog/claw-inactivity-guidance.js';

const VALID_AS_OF = '2026-08-01T12:34:56.789Z';

function v1Meta(): Record<string, string> {
  return {
    guidance_schema_version: '1',
    claw_id: 'claw-a',
    failure_class: 'daemon_silent',
    inactive_ms: '300000',
    contract: 'active:c1',
    as_of: VALID_AS_OF,
  };
}

function legacyMeta(): Record<string, string> {
  const meta = v1Meta();
  delete meta.guidance_schema_version;
  return meta;
}

function wire(meta: Record<string, string>, over?: { type?: string; from?: string }): ClawInactivityGuidanceWire {
  return { type: over?.type ?? 'claw_inactivity', from: over?.from ?? 'watchdog', meta };
}

describe('claw-inactivity-guidance codec (phase 1258)', () => {
  describe('encodeClawInactivityGuidance', () => {
    it('writes exact v1 wire shape: version + 6 owned required fields, no source_path/last_error', () => {
      const out = encodeClawInactivityGuidance({
        clawId: 'claw-a',
        failureClass: 'daemon_errored',
        inactiveMs: 300000,
        contract: 'active:c1',
        asOf: VALID_AS_OF,
      });

      // 精确 shape（多一个 key 即失败 / optional 不写空值或 sentinel）
      expect(out).toEqual({
        guidance_schema_version: '1',
        claw_id: 'claw-a',
        failure_class: 'daemon_errored',
        inactive_ms: '300000',
        contract: 'active:c1',
        as_of: VALID_AS_OF,
      });
    });

    it('writes optional source_path only for subscription trigger (typed literal)', () => {
      const out = encodeClawInactivityGuidance({
        clawId: 'claw-a',
        failureClass: 'daemon_silent',
        inactiveMs: 0,
        contract: 'active:c1',
        asOf: VALID_AS_OF,
        sourcePath: 'subscription',
      });
      expect(out.source_path).toBe('subscription');
    });

    it('writes optional last_error only when present (non-empty preserved as-is, no truncation)', () => {
      const out = encodeClawInactivityGuidance({
        clawId: 'claw-a',
        failureClass: 'daemon_errored',
        inactiveMs: 1,
        contract: 'active:c1',
        asOf: VALID_AS_OF,
        lastError: 'LLM timeout\nstack line 2',
      });
      expect(out.last_error).toBe('LLM timeout\nstack line 2');
    });

    it('rejects empty clawId / negative or non-integer inactiveMs / non-ISO asOf / empty lastError', () => {
      const base = {
        clawId: 'claw-a',
        failureClass: 'daemon_silent' as const,
        inactiveMs: 300000,
        contract: 'active:c1',
        asOf: VALID_AS_OF,
      };
      expect(() => encodeClawInactivityGuidance({ ...base, clawId: '' })).toThrow(/clawId/);
      expect(() => encodeClawInactivityGuidance({ ...base, inactiveMs: -1 })).toThrow(/inactiveMs/);
      expect(() => encodeClawInactivityGuidance({ ...base, inactiveMs: 1.5 })).toThrow(/inactiveMs/);
      expect(() => encodeClawInactivityGuidance({ ...base, inactiveMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/inactiveMs/);
      expect(() => encodeClawInactivityGuidance({ ...base, asOf: 'not a date' })).toThrow(/asOf/);
      expect(() => encodeClawInactivityGuidance({ ...base, lastError: '' })).toThrow(/lastError/);
    });
  });

  describe('decodeClawInactivityGuidance — valid', () => {
    it('v1 legal wire → typed camelCase state', () => {
      const state = decodeClawInactivityGuidance(wire(v1Meta()));
      expect(state).toEqual({
        schemaVersion: 1,
        clawId: 'claw-a',
        failureClass: 'daemon_silent',
        inactiveMs: 300000,
        contract: 'active:c1',
        asOf: VALID_AS_OF,
      });
    });

    it('legacy production shape (no version) decodes to same state (schemaVersion normalized to 1)', () => {
      const state = decodeClawInactivityGuidance(wire(legacyMeta()));
      expect(state).toEqual({
        schemaVersion: 1,
        clawId: 'claw-a',
        failureClass: 'daemon_silent',
        inactiveMs: 300000,
        contract: 'active:c1',
        asOf: VALID_AS_OF,
      });
    });

    it('legacy subscription production shape (source_path + last_error) decodes', () => {
      const state = decodeClawInactivityGuidance(wire({
        ...legacyMeta(),
        failure_class: 'daemon_errored',
        source_path: 'subscription',
        last_error: 'LLM timeout',
      }));
      expect(state).toEqual({
        schemaVersion: 1,
        clawId: 'claw-a',
        failureClass: 'daemon_errored',
        inactiveMs: 300000,
        contract: 'active:c1',
        asOf: VALID_AS_OF,
        sourcePath: 'subscription',
        lastError: 'LLM timeout',
      });
    });

    it('extra transport metadata keys are ignored, not rejected', () => {
      const state = decodeClawInactivityGuidance(wire({ ...v1Meta(), trace_id: 't-1', extra_unknown: 'x' }));
      expect(state.clawId).toBe('claw-a');
    });

    it('roundtrip timeout dialect: encode → decode preserves all fields (no optional keys)', () => {
      const input = {
        clawId: 'claw-round',
        failureClass: 'daemon_silent' as const,
        inactiveMs: 42,
        contract: 'active:c9',
        asOf: VALID_AS_OF,
      };
      const encoded = encodeClawInactivityGuidance(input);
      const state = decodeClawInactivityGuidance({ type: 'claw_inactivity', from: 'watchdog', meta: encoded });
      expect(state).toEqual({ schemaVersion: 1, ...input });
    });

    it('roundtrip subscription dialect: encode → decode preserves optional fields', () => {
      const input = {
        clawId: 'claw-round',
        failureClass: 'daemon_errored' as const,
        inactiveMs: 42,
        contract: 'active:c9',
        asOf: VALID_AS_OF,
        sourcePath: 'subscription' as const,
        lastError: 'boom',
      };
      const encoded = encodeClawInactivityGuidance(input);
      const state = decodeClawInactivityGuidance({ type: 'claw_inactivity', from: 'watchdog', meta: encoded });
      expect(state).toEqual({ schemaVersion: 1, ...input });
    });
  });

  describe('decodeClawInactivityGuidance — invalid (typed error, no fallback)', () => {
    it('unknown schema version → unknown_schema_version', () => {
      let caught: unknown;
      try {
        decodeClawInactivityGuidance(wire({ ...v1Meta(), guidance_schema_version: '2' }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ClawInactivityGuidanceDecodeError);
      expect((caught as ClawInactivityGuidanceDecodeError).reason).toBe('unknown_schema_version');
      expect((caught as ClawInactivityGuidanceDecodeError).field).toBe('guidance_schema_version');
    });

    it('wrong type → schema_invalid', () => {
      expect(() => decodeClawInactivityGuidance(wire(v1Meta(), { type: 'claw_crashed' })))
        .toThrowError(ClawInactivityGuidanceDecodeError);
    });

    it('from not watchdog → schema_invalid (owner provenance, no spoof)', () => {
      let caught: unknown;
      try {
        decodeClawInactivityGuidance(wire(v1Meta(), { from: 'claw-a' }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ClawInactivityGuidanceDecodeError);
      expect((caught as ClawInactivityGuidanceDecodeError).reason).toBe('schema_invalid');
      expect((caught as ClawInactivityGuidanceDecodeError).field).toBe('from');
    });

    it.each([
      ['unknown failure class', { failure_class: 'mystery' }, 'failure_class'],
      ['daemon_stopped class (moved to claw_crashed)', { failure_class: 'daemon_stopped' }, 'failure_class'],
      ['empty claw_id', { claw_id: '' }, 'claw_id'],
      ['negative inactive_ms', { inactive_ms: '-1' }, 'inactive_ms'],
      ['non-integer inactive_ms', { inactive_ms: '1.5' }, 'inactive_ms'],
      ['non-numeric inactive_ms', { inactive_ms: 'abc' }, 'inactive_ms'],
      ['unsafe integer inactive_ms', { inactive_ms: '9007199254740993' }, 'inactive_ms'],
      ['fuzzy date (Date.parse would accept)', { as_of: 'August 1, 2026' }, 'as_of'],
      ['non-ISO as_of', { as_of: '2026/08/01 12:00' }, 'as_of'],
      ['illegal source_path', { source_path: 'timeout' }, 'source_path'],
      ['empty source_path', { source_path: '' }, 'source_path'],
      ['empty last_error', { last_error: '' }, 'last_error'],
      ['missing claw_id', { claw_id: undefined }, 'claw_id'],
      ['missing failure_class', { failure_class: undefined }, 'failure_class'],
      ['missing inactive_ms', { inactive_ms: undefined }, 'inactive_ms'],
      ['missing contract', { contract: undefined }, 'contract'],
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
          decodeClawInactivityGuidance(wire(meta));
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ClawInactivityGuidanceDecodeError);
        expect((caught as ClawInactivityGuidanceDecodeError).reason).toBe('schema_invalid');
        expect((caught as ClawInactivityGuidanceDecodeError).field).toBe(field);
      }
    });

    it('error message carries type/field/reason only, never echoes metadata values or body', () => {
      let caught: unknown;
      try {
        decodeClawInactivityGuidance(wire({
          ...v1Meta(),
          failure_class: 'mystery',
          last_error: 'secret-error-detail',
          contract: 'active:secret-contract',
        }));
      } catch (e) {
        caught = e;
      }
      const msg = (caught as Error).message;
      expect(msg).toContain('schema_invalid');
      expect(msg).toContain('failure_class');
      expect(msg).not.toContain('secret-error-detail');
      expect(msg).not.toContain('secret-contract');
      expect(msg).not.toContain('mystery');
    });
  });

  it('CLAW_INACTIVITY_GUIDANCE_SCHEMA_VERSION is the v1 wire constant', () => {
    expect(CLAW_INACTIVITY_GUIDANCE_SCHEMA_VERSION).toBe('1');
  });
});
