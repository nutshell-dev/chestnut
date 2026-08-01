/**
 * phase 1261 Step A: ContractSystem-owned contract_events guidance codec unit tests.
 *
 * 矩阵：
 *  - encode: v1 wire 精确两字段（version + contract_refs canonical JSON），single /
 *    batch / empty / 顺序保持；非法 claw/contract ID → throw；输入 array 不被修改
 *  - decode v1: 合法 single / batch / empty → typed refs（ClawId/ContractId brand 恢复、
 *    顺序保持）；bad JSON / 非 array / 非 object item / 缺字段 / 非法 ID → typed throw
 *  - decode legacy single: 合法恢复 typed refs；缺任一字段 / 非法 ID → typed throw
 *  - decode legacy batch: 1 / 2 / empty / whitespace 兼容；malformed（无 colon）、
 *    多个 colon、部分合法 + 部分非法均整体 typed throw（不再部分过滤）
 *  - decode mixed dialect: single keys + problem_pairs 同时出现 → schema_invalid；
 *    v1 + 任一 legacy key → schema_invalid
 *  - decode envelope: 错 type / 错 from / unknown version → typed throw
 *  - 额外 generic metadata key 不拒绝
 *  - roundtrip: encode → decode 保真
 *  - typed error 断言 name/reason/field，错误消息不回显完整 payload
 */

import { describe, it, expect } from 'vitest';
import {
  ContractEventsGuidanceDecodeError,
  encodeContractEventsGuidance,
  decodeContractEventsGuidance,
  type ContractEventGuidanceRef,
  type ContractEventsGuidanceWire,
} from '../../../src/core/contract/contract-events-guidance.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import { makeContractId } from '../../../src/core/contract/types.js';

function ref(clawId: string, contractId: string): ContractEventGuidanceRef {
  return { clawId: makeClawId(clawId), contractId: makeContractId(contractId) };
}

function wire(meta: Record<string, string>, over?: { type?: string; from?: string }): ContractEventsGuidanceWire {
  return { type: over?.type ?? 'contract_events', from: over?.from ?? 'system', meta };
}

function v1Meta(refs: readonly { claw_id: string; contract_id: string }[]): Record<string, string> {
  return {
    guidance_schema_version: '1',
    contract_refs: JSON.stringify(refs),
  };
}

describe('contract-events guidance codec (phase 1261)', () => {
  describe('encodeContractEventsGuidance', () => {
    it('single ref → exact v1 wire shape（仅两字段）', () => {
      const out = encodeContractEventsGuidance([ref('worker-1', '1780-abcd')]);

      expect(out).toEqual({
        guidance_schema_version: '1',
        contract_refs: '[{"claw_id":"worker-1","contract_id":"1780-abcd"}]',
      });
    });

    it('batch refs → canonical JSON array、顺序保持', () => {
      const out = encodeContractEventsGuidance([
        ref('worker-1', '1780-abcd'),
        ref('worker-2', '1780-cdef'),
      ]);

      expect(out).toEqual({
        guidance_schema_version: '1',
        contract_refs: '[{"claw_id":"worker-1","contract_id":"1780-abcd"},{"claw_id":"worker-2","contract_id":"1780-cdef"}]',
      });
    });

    it('empty refs → 合法 v1 wire（contract_refs=[]）', () => {
      const out = encodeContractEventsGuidance([]);

      expect(out).toEqual({
        guidance_schema_version: '1',
        contract_refs: '[]',
      });
    });

    it('非法 claw ID → throw', () => {
      expect(() => encodeContractEventsGuidance([ref('worker:1', '1780-abcd')])).toThrowError(Error);
      expect(() => encodeContractEventsGuidance([ref('a'.repeat(65), '1780-abcd')])).toThrowError(Error);
    });

    it('非法 contract ID → throw', () => {
      expect(() => encodeContractEventsGuidance([ref('worker-1', 'bad,id')])).toThrowError(Error);
      expect(() => encodeContractEventsGuidance([ref('worker-1', '')])).toThrowError(Error);
    });

    it('不修改输入 array', () => {
      const input = [ref('worker-1', '1780-abcd')];
      const snapshot = [...input];
      encodeContractEventsGuidance(input);
      expect(input).toEqual(snapshot);
    });
  });

  describe('decodeContractEventsGuidance v1', () => {
    it('single → typed refs（brand 恢复）', () => {
      const state = decodeContractEventsGuidance(wire(v1Meta([{ claw_id: 'worker-1', contract_id: '1780-abcd' }])));

      expect(state.schemaVersion).toBe(1);
      expect(state.contractRefs).toEqual([{ clawId: 'worker-1', contractId: '1780-abcd' }]);
    });

    it('batch → 顺序保持', () => {
      const state = decodeContractEventsGuidance(wire(v1Meta([
        { claw_id: 'worker-2', contract_id: 'c2' },
        { claw_id: 'worker-1', contract_id: 'c1' },
      ])));

      expect(state.contractRefs).toEqual([
        { clawId: 'worker-2', contractId: 'c2' },
        { clawId: 'worker-1', contractId: 'c1' },
      ]);
    });

    it('empty array → 合法空 refs', () => {
      const state = decodeContractEventsGuidance(wire(v1Meta([])));
      expect(state.contractRefs).toEqual([]);
    });

    it('缺 contract_refs → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({ guidance_schema_version: '1' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('bad JSON → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({
        guidance_schema_version: '1',
        contract_refs: 'not-json',
      }))).toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('非 array → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({
        guidance_schema_version: '1',
        contract_refs: '{"claw_id":"worker-1"}',
      }))).toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('非 object item → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({
        guidance_schema_version: '1',
        contract_refs: '["worker-1:1780-abcd"]',
      }))).toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('item 缺字段 → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({
        guidance_schema_version: '1',
        contract_refs: '[{"claw_id":"worker-1"}]',
      }))).toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('非法 ID（注入字符 / 超长）→ typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({
        guidance_schema_version: '1',
        contract_refs: '[{"claw_id":"worker`1","contract_id":"c1"}]',
      }))).toThrowError(ContractEventsGuidanceDecodeError);
      expect(() => decodeContractEventsGuidance(wire({
        guidance_schema_version: '1',
        contract_refs: `[{"claw_id":"worker-1","contract_id":"${'c'.repeat(65)}"}]`,
      }))).toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('v1 + legacy key（mixed dialect）→ typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({
        ...v1Meta([{ claw_id: 'worker-1', contract_id: 'c1' }]),
        problem_pairs: 'worker-1:c1',
      }))).toThrowError(ContractEventsGuidanceDecodeError);
      expect(() => decodeContractEventsGuidance(wire({
        ...v1Meta([{ claw_id: 'worker-1', contract_id: 'c1' }]),
        source_claw: 'worker-1',
      }))).toThrowError(ContractEventsGuidanceDecodeError);
    });
  });

  describe('decodeContractEventsGuidance legacy', () => {
    it('legacy single → 恢复 typed ref', () => {
      const state = decodeContractEventsGuidance(wire({ source_claw: 'motion', contract_id: 'abc-123' }));

      expect(state.schemaVersion).toBe(1);
      expect(state.contractRefs).toEqual([{ clawId: 'motion', contractId: 'abc-123' }]);
    });

    it('legacy single 缺任一字段 → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({ source_claw: 'motion' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
      expect(() => decodeContractEventsGuidance(wire({ contract_id: 'abc-123' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('legacy single 非法 ID → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({ source_claw: 'mo,tion', contract_id: 'abc-123' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('legacy batch 1 pair → typed refs', () => {
      const state = decodeContractEventsGuidance(wire({ problem_pairs: 'worker-1:1780-abcd' }));
      expect(state.contractRefs).toEqual([{ clawId: 'worker-1', contractId: '1780-abcd' }]);
    });

    it('legacy batch 2 pairs → 顺序保持', () => {
      const state = decodeContractEventsGuidance(wire({ problem_pairs: 'worker-1:1780-abcd,worker-2:1780-cdef' }));
      expect(state.contractRefs).toEqual([
        { clawId: 'worker-1', contractId: '1780-abcd' },
        { clawId: 'worker-2', contractId: '1780-cdef' },
      ]);
    });

    it('legacy batch 空 string → 空 refs（真实 production shape）', () => {
      const state = decodeContractEventsGuidance(wire({ problem_pairs: '' }));
      expect(state.contractRefs).toEqual([]);
    });

    it('legacy batch whitespace 兼容', () => {
      const state = decodeContractEventsGuidance(wire({ problem_pairs: ' worker-1:abc , worker-2:def ' }));
      expect(state.contractRefs).toEqual([
        { clawId: 'worker-1', contractId: 'abc' },
        { clawId: 'worker-2', contractId: 'def' },
      ]);
    });

    it('legacy batch malformed（无 colon）→ 整条 typed throw（不再部分过滤）', () => {
      expect(() => decodeContractEventsGuidance(wire({ problem_pairs: 'malformed,worker-1:1780-abcd' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('legacy batch 多余逗号产生空 segment → 整条 typed throw（禁止静默忽略）', () => {
      // 反向 fixture：尾逗号 / 头逗号 / 双逗号 / 纯空白 segment 均不得静默跳过
      expect(() => decodeContractEventsGuidance(wire({ problem_pairs: 'worker-1:c1,' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
      expect(() => decodeContractEventsGuidance(wire({ problem_pairs: ',worker-1:c1' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
      expect(() => decodeContractEventsGuidance(wire({ problem_pairs: 'worker-1:c1,,worker-2:c2' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
      expect(() => decodeContractEventsGuidance(wire({ problem_pairs: 'worker-1:c1, ,worker-2:c2' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('legacy batch 多个 colon → 整条 typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({ problem_pairs: 'worker-1:a:b' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('legacy batch 全部 malformed → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({ problem_pairs: 'malformed1,malformed2' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('mixed legacy dialect（single keys + problem_pairs）→ typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire({
        source_claw: 'motion',
        contract_id: 'abc-123',
        problem_pairs: 'worker-1:1780-abcd',
      }))).toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('legacy + 额外 generic metadata → 不拒绝', () => {
      const state = decodeContractEventsGuidance(wire({
        source_claw: 'motion',
        contract_id: 'abc-123',
        some_other_field: 'x',
      }));
      expect(state.contractRefs).toEqual([{ clawId: 'motion', contractId: 'abc-123' }]);
    });
  });

  describe('decodeContractEventsGuidance envelope', () => {
    it('错 type → typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire(v1Meta([]), { type: 'contract_cancelled' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('错 from（非 system）→ typed throw', () => {
      expect(() => decodeContractEventsGuidance(wire(v1Meta([]), { from: 'worker-1' })))
        .toThrowError(ContractEventsGuidanceDecodeError);
    });

    it('unknown version → typed throw（不落 legacy 分支）', () => {
      let caught: unknown;
      try {
        decodeContractEventsGuidance(wire({
          guidance_schema_version: '2',
          problem_pairs: 'worker-1:1780-abcd',
        }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContractEventsGuidanceDecodeError);
      expect((caught as ContractEventsGuidanceDecodeError).reason).toBe('unknown_schema_version');
      expect((caught as ContractEventsGuidanceDecodeError).field).toBe('guidance_schema_version');
    });
  });

  describe('roundtrip 与 error 安全', () => {
    it('encode → decode 保真（含 empty）', () => {
      const refs = [ref('worker-1', '1780-abcd'), ref('worker-2', '1780-cdef')];
      const state = decodeContractEventsGuidance(wire({ ...encodeContractEventsGuidance(refs) }));
      expect(state.schemaVersion).toBe(1);
      expect(state.contractRefs).toEqual(refs);

      const empty = decodeContractEventsGuidance(wire({ ...encodeContractEventsGuidance([]) }));
      expect(empty.contractRefs).toEqual([]);
    });

    it('typed error 断言 name/reason/field，message 不回显完整 payload', () => {
      let caught: unknown;
      try {
        decodeContractEventsGuidance(wire({
          guidance_schema_version: '1',
          contract_refs: '[{"claw_id":"worker-secret-payload","contract_id":"c1-secret"},{}]',
        }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContractEventsGuidanceDecodeError);
      const err = caught as ContractEventsGuidanceDecodeError;
      expect(err.name).toBe('ContractEventsGuidanceDecodeError');
      expect(err.reason).toBe('schema_invalid');
      expect(err.field).toBeDefined();
      expect(err.message).not.toContain('worker-secret-payload');
      expect(err.message).not.toContain('c1-secret');
    });
  });
});
