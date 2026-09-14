/**
 * Guidance composer tests — mechanical merge; assertion logic unchanged.
 * Phase 1091: six fast test files consolidated to reduce per-file scheduling cost.
 */

import { describe, it, expect } from 'vitest';
import { composer as taskQueueOverflowComposer } from '../../../src/assembly/guidance/composers/task-queue-overflow.js';
import { createMotionGuidanceRegistry } from '../../../src/assembly/guidance/registry.js';
import { registerAllMotionGuidance } from '../../../src/assembly/guidance/composers/index.js';
import { clawOutboxSummaryGuidanceBinding } from '../../../src/assembly/guidance/bindings/claw-outbox-summary.js';
import { contractEventsGuidanceBinding } from '../../../src/assembly/guidance/bindings/contract-events.js';
import { contractCancelledGuidanceBinding } from '../../../src/assembly/guidance/bindings/contract-cancelled.js';
import { registerCliGuidance, createCliSafeToken, type CliGuidanceInput } from '../../../src/cli-protocol/index.js';
import { OutboxSummaryGuidanceDecodeError } from '../../../src/core/claw-topology/jobs/outbox-summary/guidance-state.js';
import {
  ContractEventsGuidanceDecodeError,
  encodeContractEventsGuidance,
  ContractCancelledGuidanceDecodeError,
  encodeContractCancelledGuidance,
} from '../../../src/core/contract/index.js';
import type { ContractEventGuidanceRef } from '../../../src/core/contract/contract-events-guidance.js';
import type { ContractCancelledGuidanceRef } from '../../../src/core/contract/contract-cancelled-guidance.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import { makeContractId } from '../../../src/core/contract/types.js';

/**
 * phase 1256 Step B: envelope fixture — 三字段（type/from/meta）完整，
 * 防止未来再次丢字段（裸 state 调用由 TypeScript 拒绝）。
 */
function env<M extends Record<string, string>>(type: string, meta: M, from = 'test-source'): { type: string; from: string; meta: M } {
  return { type, from, meta };
}

/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - task-queue-overflow-composer.test.ts
 *  - claw-outbox-summary-composer.test.ts
 */


describe('task-queue-overflow-composer', () => {
  /**
   * phase 7 γ7: task-queue-overflow real composer unit test.
   */

  describe('task-queue-overflow composer (phase 7)', () => {
    it('returns escalation guidance pointing to user', () => {
      const r = taskQueueOverflowComposer(env('task_queue_overflow', { cap: '1000', queue_length: '1000' }));
      expect(r.text).toContain('system-level overload');
      expect(r.text).toContain('Surface to the user');
      expect(r.text).toContain('developer');
      expect(r.text).toContain('Do not retry');
    });

    it('returns same guidance regardless of state fields', () => {
      const r1 = taskQueueOverflowComposer(env('task_queue_overflow', {}));
      const r2 = taskQueueOverflowComposer(env('task_queue_overflow', { cap: '500', queue_length: '500' }));
      expect(r1.text).toBe(r2.text);
    });
  });
});

describe('claw-outbox-summary typed binding (phase 1265 Step A)', () => {
  /**
   * phase 1476: claw-outbox-summary composer unit test (γ2 first real composer).
   * phase 1259 Step B: composer 只消费 ClawTopology owner codec typed state —
   *   v1/legacy 完整 production fixture 合法；NaN/0/inconsistent/malformed wire 由
   *   decoder 抛 typed error（不再静默 fallback `--limit 10`）；
   *   `<claw-id>` placeholder 保留为当前显式 presentation decision。
   * phase 1265 Step A: composer 原子迁为 Assembly typed binding —
   *   Assembly 只把 totalMsgs 映射成单个 placeholder outbox document；CLIProtocol
   *   发起注册并渲染。最终文本、placeholder、limit 与 typed decode failure 全部不变。
   */

  /** 合法 v1 wire（production shape：from 固定 system）。 */
  function v1SummaryMeta(): Record<string, string> {
    return {
      guidance_schema_version: '1',
      'summary-hash': 'abc123def456',
      counts: JSON.stringify({ clawA: 3, clawB: 1 }),
      total_claws: '2',
      total_msgs: '4',
    };
  }

  /** 合法 legacy wire（缺 version 的旧完整 production shape）。 */
  function legacySummaryMeta(): Record<string, string> {
    const meta = v1SummaryMeta();
    delete meta.guidance_schema_version;
    return {
      hash: 'abc123def456',
      ...meta,
      failed_claws: '[]',
      incomplete: 'false',
    };
  }

  /** 经 CLIProtocol register helper + binding 的真实注册路径 compose。 */
  function composeOutboxSummary(meta: Record<string, string>, from: string): { text: string } | null {
    const composers = new Map<string, (input: CliGuidanceInput) => { text: string } | null>();
    registerCliGuidance({ register: (type, composer) => composers.set(type, composer) }, [clawOutboxSummaryGuidanceBinding]);
    const composer = composers.get('claw_outbox_summary');
    if (!composer) throw new Error('claw_outbox_summary binding was not registered');
    return composer(env('claw_outbox_summary', meta, from));
  }

  const OUTBOX_EXACT = '查看具体内容： chestnut claw <claw-id> outbox --limit 4';

  describe('phase 1476 + phase 1259 + phase 1265: claw-outbox-summary typed binding', () => {
    it('v1 合法 → exact placeholder CLI guidance（真实 limit）', () => {
      expect(composeOutboxSummary(v1SummaryMeta(), 'system')).toEqual({ text: OUTBOX_EXACT });
    });

    it('legacy production shape → 同 v1 exact 输出（version 缺失不影响）', () => {
      expect(composeOutboxSummary(legacySummaryMeta(), 'system')).toEqual({ text: OUTBOX_EXACT });
    });

    it('binding 只产 typed document：placeholder target + 真实 limit，不消费 hash/counts/totalClaws', () => {
      expect(clawOutboxSummaryGuidanceBinding.type).toBe('claw_outbox_summary');
      const state = clawOutboxSummaryGuidanceBinding.decode(env('claw_outbox_summary', v1SummaryMeta(), 'system'));
      expect(clawOutboxSummaryGuidanceBinding.toDocument(state)).toEqual({
        lines: [{
          label: 'read-outbox',
          action: { kind: 'claw.outbox', target: { kind: 'placeholder', name: 'claw-id' }, limit: 4 },
        }],
      });
    });

    it('total_msgs malformed（NaN）→ decoder throws typed error（不再 fallback --limit 10）', () => {
      expect(() => composeOutboxSummary({
        ...v1SummaryMeta(),
        total_msgs: 'NaN',
      }, 'system')).toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('total_msgs = 0 → decoder throws typed error（0 不是合法 wire / tick fail-closed 守门）', () => {
      expect(() => composeOutboxSummary({
        ...v1SummaryMeta(),
        total_claws: '0',
        total_msgs: '0',
        counts: '{}',
      }, 'system')).toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('counts 与 totals 派生不一致 → decoder throws typed error', () => {
      expect(() => composeOutboxSummary({
        ...v1SummaryMeta(),
        total_msgs: '5',
      }, 'system')).toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('from 非 system → decoder throws typed error（owner provenance 不可伪装）', () => {
      expect(() => composeOutboxSummary(v1SummaryMeta(), 'clawA'))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('真实 registry end-to-end：createMotionGuidanceRegistry + registerAllMotionGuidance + compose 合法 fixture exact 输出', () => {
      const registry = createMotionGuidanceRegistry();
      registerAllMotionGuidance(registry);
      expect(registry.compose(env('claw_outbox_summary', v1SummaryMeta(), 'system')))
        .toEqual({ text: OUTBOX_EXACT });
    });

    it('真实 registry end-to-end：malformed wire typed throw 穿透（Runtime 前错误传播不变）', () => {
      const registry = createMotionGuidanceRegistry();
      registerAllMotionGuidance(registry);
      expect(() => registry.compose(env('claw_outbox_summary', { ...v1SummaryMeta(), total_msgs: 'NaN' }, 'system')))
        .toThrowError(OutboxSummaryGuidanceDecodeError);
    });
  });
});

/**
 * phase 2 γ4 + phase 4 重写 + phase 201 + phase 1257 Step B + phase 1263 Step C:
 * claw-crashed typed binding 测试。
 * phase 1263 Step C: composer 原子迁为 Assembly typed binding —
 *   Assembly 只穷尽映射 CrashClass → CliGuidanceDocument；CLIProtocol 发起注册并渲染。
 *   最终文本、命令、顺序、typed decode failure 与正文保留行为全部不变（逐字锁定）。
 */



/**
 * phase 63 γ NEW: contract_cancelled composer unit test
 * phase 190: 删 null 旁路 + 加 batch / fallback case
 * phase 198: 改最小 state-driven CLI block（trace + show）
 * phase 1262 Step B: composer 只消费 ContractSystem owner codec typed state —
 *   v1 输入经真实 encoder 构造；legacy single/batch production shape（含 reason）
 *   仍可读；malformed wire 由 decoder 抛 typed error（不再 JSON parse 后逐项静默
 *   filter / 不再 fallback single / 不再伪造 (unknown) / (no reason given)）。
 * phase 1267 Step A: composer 原子迁为 Assembly typed binding — Assembly 只把
 *   非空 refs 映射成有序 trace/show document + cap 选择；CLIProtocol 发起注册并
 *   渲染最终文本。最终文本、cap=10、reason 不渲染与 typed decode failure 全部不变；
 *   owner schema 保证 refs 非空，binding 无 null 分支（与 contract_events 相反）。
 */


/** typed ref → v1 wire（经真实 owner encoder；production from 固定 system）。 */
function v1CancelledMeta(refs: readonly { claw: string; contract: string }[]): Record<string, string> {
  const typedRefs: ContractCancelledGuidanceRef[] = refs.map(r => ({
    clawId: makeClawId(r.claw),
    contractId: makeContractId(r.contract),
  }));
  return { ...encodeContractCancelledGuidance(typedRefs) };
}

describe('phase 63+190+198 + phase 1262 + phase 1267: contract_cancelled typed binding', () => {
  /** 经 CLIProtocol register helper + binding 的真实注册路径 compose。 */
  function composeContractCancelled(meta: Record<string, string>, from: string): { text: string } | null {
    const composers = new Map<string, (input: CliGuidanceInput) => { text: string } | null>();
    registerCliGuidance({ register: (type, composer) => composers.set(type, composer) }, [contractCancelledGuidanceBinding]);
    const composer = composers.get('contract_cancelled');
    if (!composer) throw new Error('contract_cancelled binding was not registered');
    return composer(env('contract_cancelled', meta, from));
  }

  const EXACT_SINGLE = [
    '查看相关执行记录： chestnut claw worker trace --contract c1',
    '查看契约与进度摘要： chestnut contract show -c worker --contract c1',
  ].join('\n');
  const EXACT_BATCH = [
    '查看相关执行记录： chestnut claw claw1 trace --contract c1',
    '查看契约与进度摘要： chestnut contract show -c claw1 --contract c1',
    '查看相关执行记录： chestnut claw claw2 trace --contract c2',
    '查看契约与进度摘要： chestnut contract show -c claw2 --contract c2',
  ].join('\n');

  it('v1 single（真实 encoder）→ exact trace + show 两行、0 prescription', () => {
    expect(composeContractCancelled(v1CancelledMeta([{ claw: 'worker', contract: 'c1' }]), 'system'))
      .toEqual({ text: EXACT_SINGLE });
    // 三段式已删 + 0 prescription 严格守
    expect(EXACT_SINGLE).not.toContain('事实:');
    expect(EXACT_SINGLE).not.toContain('系统已做');
    expect(EXACT_SINGLE).not.toMatch(/建议|推荐|应该|必须|优先|按.*优先级/);
  });

  it('v1 batch（真实 encoder 2 refs）→ exact 按 owner 顺序 trace 后 show per ref', () => {
    expect(composeContractCancelled(v1CancelledMeta([
      { claw: 'claw1', contract: 'c1' },
      { claw: 'claw2', contract: 'c2' },
    ]), 'system')).toEqual({ text: EXACT_BATCH });
  });

  it('binding 只产 typed document：两 action 逐字段同一 ref IDs、trace 先 show 后、无 truncation、无 null 分支', () => {
    expect(contractCancelledGuidanceBinding.type).toBe('contract_cancelled');
    const state = contractCancelledGuidanceBinding.decode(
      env('contract_cancelled', v1CancelledMeta([{ claw: 'worker', contract: 'c1' }]), 'system'));
    expect(contractCancelledGuidanceBinding.toDocument(state)).toEqual({
      lines: [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: createCliSafeToken('worker'), contractId: createCliSafeToken('c1') } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: createCliSafeToken('worker'), contractId: createCliSafeToken('c1') } },
      ],
    });
  });

  it('legacy single（source_claw + contract_id + reason）→ 同 v1 single exact 输出（reason 不渲染）', () => {
    const result = composeContractCancelled({
      source_claw: 'worker',
      contract_id: 'c1',
      reason: 'user reason',
    }, 'system');
    expect(result).toEqual({ text: EXACT_SINGLE });
    expect(result!.text).not.toContain('user reason');
  });

  it('legacy batch（cancellations 1 entry）→ 同 v1 single exact 输出', () => {
    expect(composeContractCancelled({
      cancellations: JSON.stringify([
        { source_claw: 'worker', contract_id: 'c1', reason: 'r1' },
      ]),
    }, 'system')).toEqual({ text: EXACT_SINGLE });
  });

  it('legacy batch（2 entries）→ exact 按 owner 顺序 trace 后 show per entry', () => {
    expect(composeContractCancelled({
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
        { source_claw: 'claw2', contract_id: 'c2', reason: 'r2' },
      ]),
    }, 'system')).toEqual({ text: EXACT_BATCH });
  });

  it('12 refs → exact typed document：20 lines、只含前 10 refs、truncation 携带 total/shown/subject', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ claw: `claw${i}`, contract: `c${i}` }));
    const state = contractCancelledGuidanceBinding.decode(env('contract_cancelled', v1CancelledMeta(refs), 'system'));
    expect(contractCancelledGuidanceBinding.toDocument(state)).toEqual({
      truncation: { total: 12, shown: 10, subject: 'contract-cancellations' },
      lines: refs.slice(0, 10).flatMap(r => [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: createCliSafeToken(r.claw), contractId: createCliSafeToken(r.contract) } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: createCliSafeToken(r.claw), contractId: createCliSafeToken(r.contract) } },
      ]),
    });
  });

  it('caps at MAX_BATCH_RENDER=10 and shows overflow hint（v1 真实 encoder）', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ claw: `claw${i}`, contract: `c${i}` }));
    const result = composeContractCancelled(v1CancelledMeta(refs), 'system');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(12 cancellations、显示前 10)');
    expect(result!.text).toContain('claw0');
    expect(result!.text).toContain('claw9');
    expect(result!.text).not.toContain('claw10'); // 截断
    expect(result!.text).not.toContain('claw11');
  });

  it('caps at MAX_BATCH_RENDER=10（legacy batch 同 cap）', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      source_claw: `claw${i}`,
      contract_id: `c${i}`,
      reason: `r${i}`,
    }));
    const result = composeContractCancelled({ cancellations: JSON.stringify(entries) }, 'system');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(12 cancellations、显示前 10)');
    expect(result!.text).toContain('claw0');
    expect(result!.text).not.toContain('claw10'); // 截断
  });

  it('phase 1262: legacy bad JSON → decoder typed throw 穿透 register helper（不再 fallback single / 兜底）', () => {
    expect(() => composeContractCancelled({ cancellations: 'not-json' }, 'system'))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262: legacy valid+invalid batch → decoder typed throw 穿透 register helper（不再部分渲染）', () => {
    expect(() => composeContractCancelled({
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
        { source_claw: 'claw2', contract_id: 'c2' },
      ]),
    }, 'system')).toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262: legacy single 缺 source_claw → decoder typed throw（不再生成 (unknown) CLI）', () => {
    expect(() => composeContractCancelled({ contract_id: 'c1', reason: 'r1' }, 'system'))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262: legacy single 缺 reason → decoder typed throw（不再默认 (no reason given)）', () => {
    expect(() => composeContractCancelled({ source_claw: 'worker', contract_id: 'c1' }, 'system'))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262: 空 state → decoder typed throw（缺 version 且无任一 legacy owner key）', () => {
    expect(() => composeContractCancelled({}, 'system'))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262+1267: v1 空 refs → decoder typed throw（owner non-empty invariant，binding 无 null 兜底）', () => {
    expect(() => composeContractCancelled({ guidance_schema_version: '1', cancelled_contract_refs: '[]' }, 'system'))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('真实 registry end-to-end：createMotionGuidanceRegistry + registerAllMotionGuidance + compose 合法 fixture exact 输出', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    expect(registry.compose(env('contract_cancelled', v1CancelledMeta([{ claw: 'worker', contract: 'c1' }]), 'system')))
      .toEqual({ text: EXACT_SINGLE });
  });

  it('真实 registry end-to-end：malformed wire typed throw 穿透（Runtime 前错误传播不变）', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    expect(() => registry.compose(env('contract_cancelled', { cancellations: 'not-json' }, 'system')))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });
});

/**
 * phase 1487 γ5: contract-events real composer unit test.
 * phase 205: 3 旁路删 + 主路精简（state-driven CLI block + 兜底 <unknown>）
 * phase 1261 Step B: composer 只消费 ContractSystem owner codec typed state —
 *   v1 输入经真实 encoder 构造；legacy single/batch production shape 仍可读；
 *   malformed wire 由 decoder 抛 typed error（不再逐项静默过滤 / 不再返部分结果）。
 * phase 1266 Step A: composer 原子迁为 Assembly typed binding — Assembly 只把
 *   refs 映射成有序 trace/show document + cap/空态选择；CLIProtocol 发起注册并
 *   渲染最终文本。最终文本、cap=10、空 refs=null 与 typed decode failure 全部不变。
 */


/** typed ref → v1 wire（经真实 owner encoder；production from 固定 system）。 */
function v1EventsMeta(refs: readonly { claw: string; contract: string }[]): Record<string, string> {
  const typedRefs: ContractEventGuidanceRef[] = refs.map(r => ({
    clawId: makeClawId(r.claw),
    contractId: makeContractId(r.contract),
  }));
  return { ...encodeContractEventsGuidance(typedRefs) };
}

describe('phase 205 + phase 1261 + phase 1266: contract-events typed binding', () => {
  /** 经 CLIProtocol register helper + binding 的真实注册路径 compose。 */
  function composeContractEvents(meta: Record<string, string>, from: string): { text: string } | null {
    const composers = new Map<string, (input: CliGuidanceInput) => { text: string } | null>();
    registerCliGuidance({ register: (type, composer) => composers.set(type, composer) }, [contractEventsGuidanceBinding]);
    const composer = composers.get('contract_events');
    if (!composer) throw new Error('contract_events binding was not registered');
    return composer(env('contract_events', meta, from));
  }

  const EXACT_SINGLE = [
    '查看相关执行记录： chestnut claw motion trace --contract abc-123',
    '查看契约与进度摘要： chestnut contract show -c motion --contract abc-123',
  ].join('\n');
  const EXACT_BATCH = [
    '查看相关执行记录： chestnut claw worker-1 trace --contract 1780-abcd',
    '查看契约与进度摘要： chestnut contract show -c worker-1 --contract 1780-abcd',
    '查看相关执行记录： chestnut claw worker-2 trace --contract 1780-cdef',
    '查看契约与进度摘要： chestnut contract show -c worker-2 --contract 1780-cdef',
  ].join('\n');

  it('v1 single（真实 encoder）→ exact trace + show 两行', () => {
    expect(composeContractEvents(v1EventsMeta([{ claw: 'motion', contract: 'abc-123' }]), 'system'))
      .toEqual({ text: EXACT_SINGLE });
  });

  it('v1 batch（真实 encoder 2 refs）→ exact 按 owner 顺序 trace 后 show per ref', () => {
    expect(composeContractEvents(v1EventsMeta([
      { claw: 'worker-1', contract: '1780-abcd' },
      { claw: 'worker-2', contract: '1780-cdef' },
    ]), 'system')).toEqual({ text: EXACT_BATCH });
  });

  it('binding 只产 typed document：两 action 逐字段同一 ref IDs、trace 先 show 后、无 truncation', () => {
    expect(contractEventsGuidanceBinding.type).toBe('contract_events');
    const state = contractEventsGuidanceBinding.decode(
      env('contract_events', v1EventsMeta([{ claw: 'motion', contract: 'abc-123' }]), 'system'));
    expect(contractEventsGuidanceBinding.toDocument(state)).toEqual({
      lines: [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: createCliSafeToken('motion'), contractId: createCliSafeToken('abc-123') } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: createCliSafeToken('motion'), contractId: createCliSafeToken('abc-123') } },
      ],
    });
  });

  it('phase 1261: v1 空 refs → null（observer 正文覆盖全部 completed events、无失败契约；不追加 CLI guidance）', () => {
    expect(composeContractEvents(v1EventsMeta([]), 'system')).toBeNull();
    const state = contractEventsGuidanceBinding.decode(env('contract_events', v1EventsMeta([]), 'system'));
    expect(contractEventsGuidanceBinding.toDocument(state)).toBeNull();
  });

  it('legacy single（source_claw + contract_id）→ 同 v1 single exact 输出', () => {
    expect(composeContractEvents({ source_claw: 'motion', contract_id: 'abc-123' }, 'system'))
      .toEqual({ text: EXACT_SINGLE });
  });

  it('legacy batch（problem_pairs 1 pair）→ 同 v1 single exact 输出', () => {
    expect(composeContractEvents({ problem_pairs: 'worker-1:1780-abcd' }, 'system'))
      .toEqual({ text: '查看相关执行记录： chestnut claw worker-1 trace --contract 1780-abcd\n查看契约与进度摘要： chestnut contract show -c worker-1 --contract 1780-abcd' });
  });

  it('legacy batch（2 pairs）→ exact 按 owner 顺序 trace 后 show per pair', () => {
    expect(composeContractEvents({ problem_pairs: 'worker-1:1780-abcd,worker-2:1780-cdef' }, 'system'))
      .toEqual({ text: EXACT_BATCH });
  });

  it('legacy 空 problem_pairs → null（不渲染 <unknown>）', () => {
    expect(composeContractEvents({ problem_pairs: '' }, 'system')).toBeNull();
  });

  it('legacy batch trims whitespace around pairs', () => {
    expect(composeContractEvents({ problem_pairs: ' worker-1:abc , worker-2:def ' }, 'system'))
      .toEqual({ text: [
        '查看相关执行记录： chestnut claw worker-1 trace --contract abc',
        '查看契约与进度摘要： chestnut contract show -c worker-1 --contract abc',
        '查看相关执行记录： chestnut claw worker-2 trace --contract def',
        '查看契约与进度摘要： chestnut contract show -c worker-2 --contract def',
      ].join('\n') });
  });

  it('phase 1261: legacy malformed pair → decoder typed throw（不再跳过坏项保留其余）', () => {
    expect(() => composeContractEvents({ problem_pairs: 'malformed,worker-1:1780-abcd' }, 'system'))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });

  it('phase 1261: legacy all malformed pairs → decoder typed throw（不再返 null）', () => {
    expect(() => composeContractEvents({ problem_pairs: 'malformed1,malformed2' }, 'system'))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });

  it('phase 1261: legacy single 缺 contract_id → decoder typed throw（不再返 null）', () => {
    expect(() => composeContractEvents({ source_claw: 'motion' }, 'system'))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });

  it('phase 1261: 空 state → decoder typed throw（缺 version 且无任一 legacy owner key）', () => {
    expect(() => composeContractEvents({}, 'system'))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });

  it('12 refs → exact typed document：20 lines、只含前 10 refs、truncation 携带 total/shown/subject', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ claw: `worker-${i}`, contract: `c${i}` }));
    const state = contractEventsGuidanceBinding.decode(env('contract_events', v1EventsMeta(refs), 'system'));
    expect(contractEventsGuidanceBinding.toDocument(state)).toEqual({
      truncation: { total: 12, shown: 10, subject: 'contract-events' },
      lines: refs.slice(0, 10).flatMap(r => [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: createCliSafeToken(r.claw), contractId: createCliSafeToken(r.contract) } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: createCliSafeToken(r.claw), contractId: createCliSafeToken(r.contract) } },
      ]),
    });
  });

  it('caps at MAX_PAIR_RENDER=10 and shows overflow hint（v1 真实 encoder）', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ claw: `worker-${i}`, contract: `c${i}` }));
    const result = composeContractEvents(v1EventsMeta(refs), 'system');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(12 contract events、显示前 10)');
    // 只应出现前 10 个
    expect(result!.text).toContain('worker-0');
    expect(result!.text).toContain('worker-9');
    expect(result!.text).not.toContain('worker-10');
    expect(result!.text).not.toContain('worker-11');
  });

  it('caps at MAX_PAIR_RENDER=10（legacy batch 同 cap）', () => {
    const pairs = Array.from({ length: 12 }, (_, i) => `worker-${i}:c${i}`).join(',');
    const result = composeContractEvents({ problem_pairs: pairs }, 'system');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(12 contract events、显示前 10)');
    expect(result!.text).toContain('worker-0');
    expect(result!.text).toContain('worker-9');
    expect(result!.text).not.toContain('worker-10');
    expect(result!.text).not.toContain('worker-11');
  });

  it('真实 registry end-to-end：createMotionGuidanceRegistry + registerAllMotionGuidance + compose 合法 fixture exact 输出', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    expect(registry.compose(env('contract_events', v1EventsMeta([{ claw: 'motion', contract: 'abc-123' }]), 'system')))
      .toEqual({ text: EXACT_SINGLE });
  });

  it('真实 registry end-to-end：空 refs → null（合法 owner state 不追加 guidance）', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    expect(registry.compose(env('contract_events', v1EventsMeta([]), 'system'))).toBeNull();
  });

  it('真实 registry end-to-end：malformed wire typed throw 穿透（Runtime 前错误传播不变）', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    expect(() => registry.compose(env('contract_events', { problem_pairs: 'malformed,worker-1:1780-abcd' }, 'system')))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });
});

