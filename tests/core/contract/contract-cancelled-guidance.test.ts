/**
 * phase 1262 Step A: ContractSystem-owned contract_cancelled guidance codec unit tests.
 *
 * 矩阵：
 *  - encode: v1 wire 精确两字段（version + cancelled_contract_refs canonical JSON），
 *    single / batch / 顺序保持；空 refs → throw（non-empty invariant）；非法
 *    claw/contract ID → throw；输入 array 不被修改
 *  - decode v1: 合法 single / batch → typed refs（ClawId/ContractId brand 恢复、
 *    顺序保持）；空 array / bad JSON / 非 array / 非 object item（含 null item）/
 *    缺字段 / 非法 ID / 携带 legacy key → typed throw
 *  - decode legacy single: 合法恢复 typed refs（reason 不跨 typed state）；缺/空
 *    source_claw、contract_id、reason 逐项 → typed throw
 *  - decode legacy batch: 1 / 2 条合法；空 array、bad JSON、null entry、缺 reason、
 *    空 reason、valid+invalid 组合均整体 typed throw（不再部分过滤）
 *  - decode mixed dialect: cancellations 与任一 single key 并存 → schema_invalid；
 *    v1 + 任一 legacy key → schema_invalid
 *  - decode envelope: 错 type / 错 from / unknown version → typed throw
 *  - 额外 generic metadata key 不拒绝
 *  - roundtrip: encode → decode 保真
 *  - typed error 断言 name/reason/field，错误消息不回显完整 payload / reason
 */

import { describe, it, expect } from 'vitest';
import {
  ContractCancelledGuidanceDecodeError,
  encodeContractCancelledGuidance,
  decodeContractCancelledGuidance,
  type ContractCancelledGuidanceRef,
  type ContractCancelledGuidanceWire,
} from '../../../src/core/contract/contract-cancelled-guidance.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import { makeContractId } from '../../../src/core/contract/types.js';

function ref(clawId: string, contractId: string): ContractCancelledGuidanceRef {
  return { clawId: makeClawId(clawId), contractId: makeContractId(contractId) };
}

function wire(meta: Record<string, string>, over?: { type?: string; from?: string }): ContractCancelledGuidanceWire {
  return { type: over?.type ?? 'contract_cancelled', from: over?.from ?? 'system', meta };
}

function v1Meta(refs: readonly { claw_id: string; contract_id: string }[]): Record<string, string> {
  return {
    guidance_schema_version: '1',
    cancelled_contract_refs: JSON.stringify(refs),
  };
}

describe('contract-cancelled guidance codec (phase 1262)', () => {
  describe('encodeContractCancelledGuidance', () => {
    it('single ref → exact v1 wire shape（仅两字段）', () => {
      const out = encodeContractCancelledGuidance([ref('worker-1', 'c1')]);

      expect(out).toEqual({
        guidance_schema_version: '1',
        cancelled_contract_refs: '[{"claw_id":"worker-1","contract_id":"c1"}]',
      });
    });

    it('batch refs → canonical JSON array、顺序保持', () => {
      const out = encodeContractCancelledGuidance([
        ref('worker-1', 'c1'),
        ref('worker-2', 'c2'),
      ]);

      expect(out).toEqual({
        guidance_schema_version: '1',
        cancelled_contract_refs: '[{"claw_id":"worker-1","contract_id":"c1"},{"claw_id":"worker-2","contract_id":"c2"}]',
      });
    });

    it('empty refs → throw（non-empty invariant：空 refs 无真实业务来源）', () => {
      expect(() => encodeContractCancelledGuidance([])).toThrowError(Error);
    });

    it('非法 claw ID → throw', () => {
      expect(() => encodeContractCancelledGuidance([ref('worker:1', 'c1')])).toThrowError(Error);
      expect(() => encodeContractCancelledGuidance([ref('a'.repeat(65), 'c1')])).toThrowError(Error);
    });

    it('非法 contract ID → throw', () => {
      expect(() => encodeContractCancelledGuidance([ref('worker-1', 'bad,id')])).toThrowError(Error);
      expect(() => encodeContractCancelledGuidance([ref('worker-1', '')])).toThrowError(Error);
    });

    it('不修改输入 array', () => {
      const input = [ref('worker-1', 'c1')];
      const snapshot = [...input];
      encodeContractCancelledGuidance(input);
      expect(input).toEqual(snapshot);
    });
  });

  describe('decodeContractCancelledGuidance v1', () => {
    it('single → typed refs（brand 恢复）', () => {
      const state = decodeContractCancelledGuidance(wire(v1Meta([{ claw_id: 'worker-1', contract_id: 'c1' }])));

      expect(state.schemaVersion).toBe(1);
      expect(state.contractRefs).toEqual([{ clawId: 'worker-1', contractId: 'c1' }]);
    });

    it('batch → 顺序保持', () => {
      const state = decodeContractCancelledGuidance(wire(v1Meta([
        { claw_id: 'worker-2', contract_id: 'c2' },
        { claw_id: 'worker-1', contract_id: 'c1' },
      ])));

      expect(state.contractRefs).toEqual([
        { clawId: 'worker-2', contractId: 'c2' },
        { clawId: 'worker-1', contractId: 'c1' },
      ]);
    });

    it('empty array → typed throw（non-empty invariant）', () => {
      expect(() => decodeContractCancelledGuidance(wire(v1Meta([]))))
        .toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('缺 cancelled_contract_refs → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({ guidance_schema_version: '1' })))
        .toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('bad JSON → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        guidance_schema_version: '1',
        cancelled_contract_refs: 'not-json',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('非 array → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        guidance_schema_version: '1',
        cancelled_contract_refs: '{"claw_id":"worker-1","contract_id":"c1"}',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('非 object item → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        guidance_schema_version: '1',
        cancelled_contract_refs: '["worker-1:c1"]',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('null item → typed throw（防 .filter() 式部分成功回流）', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        guidance_schema_version: '1',
        cancelled_contract_refs: '[null]',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('item 缺字段 → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        guidance_schema_version: '1',
        cancelled_contract_refs: '[{"claw_id":"worker-1"}]',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('非法 ID（注入字符 / 超长）→ typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        guidance_schema_version: '1',
        cancelled_contract_refs: '[{"claw_id":"worker`1","contract_id":"c1"}]',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
      expect(() => decodeContractCancelledGuidance(wire({
        guidance_schema_version: '1',
        cancelled_contract_refs: `[{"claw_id":"worker-1","contract_id":"${'c'.repeat(65)}"}]`,
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('valid + invalid 组合 → 整体 typed throw（不部分返回）', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        guidance_schema_version: '1',
        cancelled_contract_refs: '[{"claw_id":"worker-1","contract_id":"c1"},{}]',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('v1 + legacy key（mixed dialect）→ typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        ...v1Meta([{ claw_id: 'worker-1', contract_id: 'c1' }]),
        cancellations: '[]',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
      expect(() => decodeContractCancelledGuidance(wire({
        ...v1Meta([{ claw_id: 'worker-1', contract_id: 'c1' }]),
        source_claw: 'worker-1',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
      expect(() => decodeContractCancelledGuidance(wire({
        ...v1Meta([{ claw_id: 'worker-1', contract_id: 'c1' }]),
        reason: 'r',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });
  });

  describe('decodeContractCancelledGuidance legacy single', () => {
    it('合法 legacy single → 恢复 typed ref（reason 不跨 typed state）', () => {
      const state = decodeContractCancelledGuidance(wire({
        source_claw: 'worker-1',
        contract_id: 'c1',
        reason: 'user cancelled',
      }));

      expect(state.schemaVersion).toBe(1);
      expect(state.contractRefs).toEqual([{ clawId: 'worker-1', contractId: 'c1' }]);
      expect(state).not.toHaveProperty('reason');
    });

    it('缺 source_claw → typed throw（不再伪造 (unknown)）', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        contract_id: 'c1',
        reason: 'user cancelled',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('空 source_claw → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        source_claw: '',
        contract_id: 'c1',
        reason: 'user cancelled',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('缺 contract_id → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        source_claw: 'worker-1',
        reason: 'user cancelled',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('缺 reason → typed throw（不再默认 (no reason given)）', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        source_claw: 'worker-1',
        contract_id: 'c1',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('空 reason → typed throw（empty string 不代表语义完整）', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        source_claw: 'worker-1',
        contract_id: 'c1',
        reason: '',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('非法 ID → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        source_claw: 'wo,rker',
        contract_id: 'c1',
        reason: 'user cancelled',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });
  });

  describe('decodeContractCancelledGuidance legacy batch', () => {
    it('1 entry → typed refs', () => {
      const state = decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([{ source_claw: 'claw1', contract_id: 'c1', reason: 'r1' }]),
      }));
      expect(state.contractRefs).toEqual([{ clawId: 'claw1', contractId: 'c1' }]);
    });

    it('2 entries → 顺序保持', () => {
      const state = decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([
          { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
          { source_claw: 'claw2', contract_id: 'c2', reason: 'r2' },
        ]),
      }));
      expect(state.contractRefs).toEqual([
        { clawId: 'claw1', contractId: 'c1' },
        { clawId: 'claw2', contractId: 'c2' },
      ]);
    });

    it('空 array → typed throw（真实 refs 不可能为空）', () => {
      expect(() => decodeContractCancelledGuidance(wire({ cancellations: '[]' })))
        .toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it("cancellations='' → 进入 batch 解析并失败（不 truthy fallback single/empty）", () => {
      expect(() => decodeContractCancelledGuidance(wire({ cancellations: '' })))
        .toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('bad JSON → typed throw（不 fallback single）', () => {
      expect(() => decodeContractCancelledGuidance(wire({ cancellations: 'not-json' })))
        .toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('非 array → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: '{"source_claw":"claw1","contract_id":"c1","reason":"r1"}',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('null entry → 整条 typed throw（不再 filter 跳过）', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([null, { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' }]),
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('entry 缺 reason → 整条 typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([{ source_claw: 'claw1', contract_id: 'c1' }]),
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('entry 空 reason → 整条 typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([{ source_claw: 'claw1', contract_id: 'c1', reason: '' }]),
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('entry 缺 source_claw / contract_id → 整条 typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([{ contract_id: 'c1', reason: 'r1' }]),
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([{ source_claw: 'claw1', reason: 'r1' }]),
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('valid + invalid 组合 → 整体 typed throw（禁止部分成功）', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([
          { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
          { source_claw: 'claw2', contract_id: 'c2' },
        ]),
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('全部 malformed → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: JSON.stringify([{ bad: true }, { also: 'bad' }]),
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });
  });

  describe('decodeContractCancelledGuidance mixed / envelope', () => {
    it('mixed legacy dialect（cancellations + 任一 single key）→ typed throw', () => {
      const batch = JSON.stringify([{ source_claw: 'claw1', contract_id: 'c1', reason: 'r1' }]);
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: batch,
        source_claw: 'claw1',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: batch,
        contract_id: 'c1',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
      expect(() => decodeContractCancelledGuidance(wire({
        cancellations: batch,
        reason: 'r1',
      }))).toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('错 type → typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire(v1Meta([{ claw_id: 'worker-1', contract_id: 'c1' }]), { type: 'contract_events' })))
        .toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('错 from（非 system）→ typed throw', () => {
      expect(() => decodeContractCancelledGuidance(wire(v1Meta([{ claw_id: 'worker-1', contract_id: 'c1' }]), { from: 'worker-1' })))
        .toThrowError(ContractCancelledGuidanceDecodeError);
    });

    it('unknown version → typed throw（不落 legacy 分支）', () => {
      let caught: unknown;
      try {
        decodeContractCancelledGuidance(wire({
          guidance_schema_version: '2',
          cancellations: JSON.stringify([{ source_claw: 'claw1', contract_id: 'c1', reason: 'r1' }]),
        }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContractCancelledGuidanceDecodeError);
      expect((caught as ContractCancelledGuidanceDecodeError).reason).toBe('unknown_schema_version');
      expect((caught as ContractCancelledGuidanceDecodeError).field).toBe('guidance_schema_version');
    });

    it('legacy + 额外 generic metadata → 不拒绝', () => {
      const state = decodeContractCancelledGuidance(wire({
        source_claw: 'worker-1',
        contract_id: 'c1',
        reason: 'user cancelled',
        some_other_field: 'x',
      }));
      expect(state.contractRefs).toEqual([{ clawId: 'worker-1', contractId: 'c1' }]);
    });
  });

  describe('roundtrip 与 error 安全', () => {
    it('encode → decode 保真', () => {
      const refs = [ref('worker-1', 'c1'), ref('worker-2', 'c2')];
      const state = decodeContractCancelledGuidance(wire({ ...encodeContractCancelledGuidance(refs) }));
      expect(state.schemaVersion).toBe(1);
      expect(state.contractRefs).toEqual(refs);
    });

    it('typed error 断言 name/reason/field，message 不回显完整 payload / reason', () => {
      let caught: unknown;
      try {
        decodeContractCancelledGuidance(wire({
          guidance_schema_version: '1',
          cancelled_contract_refs: '[{"claw_id":"worker-secret-payload","contract_id":"c1-secret"},{}]',
        }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContractCancelledGuidanceDecodeError);
      const err = caught as ContractCancelledGuidanceDecodeError;
      expect(err.name).toBe('ContractCancelledGuidanceDecodeError');
      expect(err.reason).toBe('schema_invalid');
      expect(err.field).toBeDefined();
      expect(err.message).not.toContain('worker-secret-payload');
      expect(err.message).not.toContain('c1-secret');
    });

    it('legacy 缺 reason 的 error message 不回显 reason 内容', () => {
      let caught: unknown;
      try {
        decodeContractCancelledGuidance(wire({
          cancellations: JSON.stringify([{ source_claw: 'claw1', contract_id: 'c1', reason: '' }]),
        }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContractCancelledGuidanceDecodeError);
      const err = caught as ContractCancelledGuidanceDecodeError;
      expect(err.field).toBe('reason');
      expect(err.message).not.toContain('claw1');
      expect(err.message).not.toContain('c1');
    });
  });
});
