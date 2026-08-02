/**
 * Guidance composer tests — mechanical merge; assertion logic unchanged.
 * Phase 1091: six fast test files consolidated to reduce per-file scheduling cost.
 */

import { describe, it, expect } from 'vitest';
import { composer as taskQueueOverflowComposer } from '../../../src/assembly/guidance/composers/task-queue-overflow.js';
import { composer as clawOutboxSummaryComposer } from '../../../src/assembly/guidance/composers/claw-outbox-summary.js';
import { clawCrashedGuidanceBinding } from '../../../src/assembly/guidance/bindings/claw-crashed.js';
import { createMotionGuidanceRegistry } from '../../../src/assembly/guidance/registry.js';
import { registerAllMotionGuidance } from '../../../src/assembly/guidance/composers/index.js';
import { clawInactivityGuidanceBinding } from '../../../src/assembly/guidance/bindings/claw-inactivity.js';
import { composer as contractCancelledComposer } from '../../../src/assembly/guidance/composers/contract-cancelled.js';
import { composer as contractEventsComposer } from '../../../src/assembly/guidance/composers/contract-events.js';
import { renderClawInvocation, CONTRACT_COMMANDS, registerCliGuidance, type CliGuidanceInput } from '../../../src/cli-protocol/index.js';
import { ClawCrashedGuidanceDecodeError } from '../../../src/watchdog/claw-crashed-guidance.js';
import { ClawInactivityGuidanceDecodeError } from '../../../src/watchdog/claw-inactivity-guidance.js';
import { OutboxSummaryGuidanceDecodeError } from '../../../src/core/claw-topology/jobs/outbox-summary/guidance-state.js';
import {
  ContractEventsGuidanceDecodeError,
  encodeContractEventsGuidance,
  type ContractEventGuidanceRef,
  ContractCancelledGuidanceDecodeError,
  encodeContractCancelledGuidance,
  type ContractCancelledGuidanceRef,
} from '../../../src/core/contract/index.js';
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

describe('claw-outbox-summary-composer', () => {
  /**
   * phase 1476: claw-outbox-summary composer unit test (γ2 first real composer).
   * phase 1259 Step B: composer 只消费 ClawTopology owner codec typed state —
   *   v1/legacy 完整 production fixture 合法；NaN/0/inconsistent/malformed wire 由
   *   decoder 抛 typed error（不再静默 fallback `--limit 10`）；
   *   `<claw-id>` placeholder 保留为当前显式 presentation decision。
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

  describe('phase 1476 + phase 1259: claw-outbox-summary composer', () => {
    it('v1 合法 → non-null guidance with subject-first CLI（真实 limit）', () => {
      const result = clawOutboxSummaryComposer(env('claw_outbox_summary', v1SummaryMeta(), 'system'));
      expect(result.text).toContain('chestnut claw <claw-id> outbox');
      expect(result.text).toContain('--limit 4');
    });

    it('legacy production shape → 同 v1 输出（version 缺失不影响）', () => {
      const result = clawOutboxSummaryComposer(env('claw_outbox_summary', legacySummaryMeta(), 'system'));
      expect(result.text).toContain('chestnut claw <claw-id> outbox');
      expect(result.text).toContain('--limit 4');
    });

    it('total_msgs malformed（NaN）→ decoder throws typed error（不再 fallback --limit 10）', () => {
      expect(() => clawOutboxSummaryComposer(env('claw_outbox_summary', {
        ...v1SummaryMeta(),
        total_msgs: 'NaN',
      }, 'system'))).toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('total_msgs = 0 → decoder throws typed error（0 不是合法 wire / tick fail-closed 守门）', () => {
      expect(() => clawOutboxSummaryComposer(env('claw_outbox_summary', {
        ...v1SummaryMeta(),
        total_claws: '0',
        total_msgs: '0',
        counts: '{}',
      }, 'system'))).toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('counts 与 totals 派生不一致 → decoder throws typed error', () => {
      expect(() => clawOutboxSummaryComposer(env('claw_outbox_summary', {
        ...v1SummaryMeta(),
        total_msgs: '5',
      }, 'system'))).toThrowError(OutboxSummaryGuidanceDecodeError);
    });

    it('from 非 system → decoder throws typed error（owner provenance 不可伪装）', () => {
      expect(() => clawOutboxSummaryComposer(env('claw_outbox_summary', v1SummaryMeta(), 'clawA')))
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


/** 合法 v1 wire（production shape：identity 只在 from，metadata 无 claw_id）。 */
function v1CrashMeta(crashClass: string): Record<string, string> {
  return {
    guidance_schema_version: '1',
    crash_class: crashClass,
    clean_stop_marker: 'false',
    contract: 'active:c1',
    outbox_pending: '0',
    as_of: '2026-08-01T12:00:00.000Z',
  };
}

/** 合法 legacy wire（缺 version 的旧 production shape）。 */
function legacyCrashMeta(crashClass: string): Record<string, string> {
  const meta = v1CrashMeta(crashClass);
  delete meta.guidance_schema_version;
  return meta;
}

/** 经 CLIProtocol register helper + binding 的真实注册路径 compose。 */
function composeCrashed(meta: Record<string, string>, from: string): { text: string } | null {
  const composers = new Map<string, (input: CliGuidanceInput) => { text: string } | null>();
  registerCliGuidance({ register: (type, composer) => composers.set(type, composer) }, [clawCrashedGuidanceBinding]);
  const composer = composers.get('claw_crashed');
  if (!composer) throw new Error('claw_crashed binding was not registered');
  return composer(env('claw_crashed', meta, from));
}

describe('claw-crashed typed binding (phase 1263 Step C)', () => {
  it('active_unexpected v1 → exact 2-line guidance: restart + diagnostic CLI, target = envelope from (phase 4)', () => {
    const r = composeCrashed(v1CrashMeta('active_unexpected'), 'claw-real');
    expect(r).toEqual({
      text: 'To restart: chestnut claw claw-real daemon\n' +
        'To inspect what the claw was doing before crash: chestnut claw claw-real steps',
    });
  });

  it('active_unexpected legacy production shape → 同 v1 exact 输出（version 缺失不影响）', () => {
    const r = composeCrashed(legacyCrashMeta('active_unexpected'), 'claw-real');
    expect(r).toEqual({
      text: 'To restart: chestnut claw claw-real daemon\n' +
        'To inspect what the claw was doing before crash: chestnut claw claw-real steps',
    });
  });

  it('active_user_stopped → exact read-only inspect guidance (status + steps)、不附 restart 暗示 (phase 201)', () => {
    const r = composeCrashed(v1CrashMeta('active_user_stopped'), 'claw-real');
    expect(r).toEqual({
      text: 'To check current status: chestnut claw claw-real status\n' +
        'To inspect what the claw was doing: chestnut claw claw-real steps',
    });
    expect(r!.text).not.toContain('daemon');
  });

  it('binding 只产 typed document：exhaustive CrashClass 映射、不含 prose/CLI literal 职责', () => {
    expect(clawCrashedGuidanceBinding.type).toBe('claw_crashed');
    const state = clawCrashedGuidanceBinding.decode(env('claw_crashed', v1CrashMeta('active_unexpected'), 'claw-real'));
    expect(clawCrashedGuidanceBinding.toDocument(state)).toEqual({
      lines: [
        { label: 'restart', action: { kind: 'claw.daemon', target: { kind: 'claw', id: 'claw-real' } } },
        { label: 'inspect-before-crash', action: { kind: 'claw.steps', target: { kind: 'claw', id: 'claw-real' } } },
      ],
    });
  });

  it('unknown crash_class → decoder typed throw 穿透 register helper（不再产 fallback inspect）', () => {
    expect(() => composeCrashed(v1CrashMeta('mystery'), 'claw-real'))
      .toThrowError(ClawCrashedGuidanceDecodeError);
  });

  it('缺 owned field（outbox_pending）→ decoder typed throw（v1 与 legacy 同）', () => {
    const v1 = v1CrashMeta('active_unexpected');
    delete v1.outbox_pending;
    expect(() => composeCrashed(v1, 'claw-real'))
      .toThrowError(ClawCrashedGuidanceDecodeError);
    const legacy = legacyCrashMeta('active_unexpected');
    delete legacy.outbox_pending;
    expect(() => composeCrashed(legacy, 'claw-real'))
      .toThrowError(ClawCrashedGuidanceDecodeError);
  });

  it('空 from → decoder typed throw（不再产 <claw-id> placeholder）', () => {
    expect(() => composeCrashed(v1CrashMeta('active_unexpected'), ''))
      .toThrowError(ClawCrashedGuidanceDecodeError);
  });

  it('真实 registry end-to-end：createMotionGuidanceRegistry + registerAllMotionGuidance + compose 合法 fixture exact 输出', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    const r = registry.compose(env('claw_crashed', v1CrashMeta('active_user_stopped'), 'claw-real'));
    expect(r).toEqual({
      text: 'To check current status: chestnut claw claw-real status\n' +
        'To inspect what the claw was doing: chestnut claw claw-real steps',
    });
  });

  it('真实 registry end-to-end：malformed wire typed throw 穿透（Runtime 前错误传播不变）', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    expect(() => registry.compose(env('claw_crashed', v1CrashMeta('mystery'), 'claw-real')))
      .toThrowError(ClawCrashedGuidanceDecodeError);
  });
});

/**
 * phase 1482 + phase 2 reframe + phase 4 重写 + phase 201 + phase 1258 Step B + phase 1264 Step A:
 * claw-inactivity typed binding 测试。daemon_stopped case 已移除（归 claw_crashed binding 覆盖）.
 * phase 4: guidance 字面英文化.
 * phase 1258 Step B: composer 只消费 Watchdog owner codec typed state —
 *   `claw_id` 来自 owner metadata（envelope from 固定 watchdog = 发起模块业务语义）；
 *   unknown class / 缺字段 / 错 from 由 decoder 抛 typed error（不再产 fallback / `<claw-id>` placeholder）。
 * phase 1264 Step A: composer 原子迁为 Assembly typed binding —
 *   Assembly 只穷尽映射 FailureClass → CliGuidanceDocument；CLIProtocol 发起注册并渲染。
 *   最终文本、命令、顺序、固定 `5m`、typed decode failure 与正文保留行为全部不变（逐字锁定）。
 */


/** 合法 v1 wire（production shape：from 固定 watchdog，claw_id 在 owner metadata）。 */
function v1InactivityMeta(failureClass: string): Record<string, string> {
  return {
    guidance_schema_version: '1',
    claw_id: 'clawA',
    failure_class: failureClass,
    inactive_ms: '300000',
    contract: 'active:c1',
    as_of: '2026-08-01T12:00:00.000Z',
  };
}

/** 合法 legacy wire（缺 version 的旧 production shape）。 */
function legacyInactivityMeta(failureClass: string): Record<string, string> {
  const meta = v1InactivityMeta(failureClass);
  delete meta.guidance_schema_version;
  return meta;
}

/** 经 CLIProtocol register helper + binding 的真实注册路径 compose。 */
function composeInactivity(meta: Record<string, string>, from: string): { text: string } | null {
  const composers = new Map<string, (input: CliGuidanceInput) => { text: string } | null>();
  registerCliGuidance({ register: (type, composer) => composers.set(type, composer) }, [clawInactivityGuidanceBinding]);
  const composer = composers.get('claw_inactivity');
  if (!composer) throw new Error('claw_inactivity binding was not registered');
  return composer(env('claw_inactivity', meta, from));
}

const SILENT_EXACT =
  'To inspect what the agent is stuck on: chestnut claw clawA steps\n' +
  'To be notified if it remains stuck after intervention: chestnut claw clawA watch --inactive-after 5m';
const ERRORED_EXACT =
  'To inspect: chestnut claw clawA steps\n' +
  'To be notified if it remains stuck after intervention: chestnut claw clawA watch --inactive-after 5m';

describe('claw-inactivity typed binding (phase 1264 Step A)', () => {
  it('daemon_silent v1 → exact 2-line guidance: inspect-stuck + watch CLI, target = owner claw_id', () => {
    const r = composeInactivity(v1InactivityMeta('daemon_silent'), 'watchdog');
    expect(r).toEqual({ text: SILENT_EXACT });
  });

  it('daemon_silent legacy production shape → 同 v1 exact 输出（version 缺失不影响）', () => {
    const r = composeInactivity(legacyInactivityMeta('daemon_silent'), 'watchdog');
    expect(r).toEqual({ text: SILENT_EXACT });
  });

  it('daemon_errored v1 → exact 2-line guidance: inspect + watch CLI', () => {
    const r = composeInactivity(v1InactivityMeta('daemon_errored'), 'watchdog');
    expect(r).toEqual({ text: ERRORED_EXACT });
  });

  it('subscription production shape（含 source_path + last_error）→ exact 同普通 daemon_errored（binding 不重灌 body 事实）', () => {
    const r = composeInactivity({
      ...v1InactivityMeta('daemon_errored'),
      source_path: 'subscription',
      last_error: 'LLM timeout',
    }, 'watchdog');
    expect(r).toEqual({ text: ERRORED_EXACT });
  });

  it('binding 只产 typed document：exhaustive FailureClass 映射、不含 prose/CLI literal 或无关 owner facts', () => {
    expect(clawInactivityGuidanceBinding.type).toBe('claw_inactivity');
    const state = clawInactivityGuidanceBinding.decode(env('claw_inactivity', v1InactivityMeta('daemon_errored'), 'watchdog'));
    expect(clawInactivityGuidanceBinding.toDocument(state)).toEqual({
      lines: [
        { label: 'inspect', action: { kind: 'claw.steps', target: { kind: 'claw', id: 'clawA' } } },
        { label: 'watch-after-intervention', action: { kind: 'claw.watch', target: { kind: 'claw', id: 'clawA' }, inactiveAfter: '5m' } },
      ],
    });
    const silentState = clawInactivityGuidanceBinding.decode(env('claw_inactivity', v1InactivityMeta('daemon_silent'), 'watchdog'));
    expect(clawInactivityGuidanceBinding.toDocument(silentState)).toEqual({
      lines: [
        { label: 'inspect-stuck', action: { kind: 'claw.steps', target: { kind: 'claw', id: 'clawA' } } },
        { label: 'watch-after-intervention', action: { kind: 'claw.watch', target: { kind: 'claw', id: 'clawA' }, inactiveAfter: '5m' } },
      ],
    });
  });

  it('daemon_stopped → decoder typed throw 穿透 register helper（不再产 fallback guidance）', () => {
    expect(() => composeInactivity(v1InactivityMeta('daemon_stopped'), 'watchdog'))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });

  it('unknown failure_class → decoder typed throw 穿透 register helper（不再产 fallback guidance）', () => {
    expect(() => composeInactivity(v1InactivityMeta('mystery_class'), 'watchdog'))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });

  it('missing claw_id (daemon_silent) → decoder typed throw（不再产 <claw-id> placeholder）', () => {
    const meta = v1InactivityMeta('daemon_silent');
    delete meta.claw_id;
    expect(() => composeInactivity(meta, 'watchdog'))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });

  it('from 非 watchdog → decoder typed throw（owner provenance 不可伪装）', () => {
    expect(() => composeInactivity(v1InactivityMeta('daemon_silent'), 'clawA'))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });

  it('真实 registry end-to-end：createMotionGuidanceRegistry + registerAllMotionGuidance + compose 合法 fixture exact 输出', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    const r = registry.compose(env('claw_inactivity', v1InactivityMeta('daemon_silent'), 'watchdog'));
    expect(r).toEqual({ text: SILENT_EXACT });
  });

  it('真实 registry end-to-end：malformed wire typed throw 穿透（Runtime 前错误传播不变）', () => {
    const registry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(registry);
    expect(() => registry.compose(env('claw_inactivity', v1InactivityMeta('mystery_class'), 'watchdog')))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });
});

/**
 * phase 63 γ NEW: contract_cancelled composer unit test
 * phase 190: 删 null 旁路 + 加 batch / fallback case
 * phase 198: 改最小 state-driven CLI block（trace + show）
 * phase 1262 Step B: composer 只消费 ContractSystem owner codec typed state —
 *   v1 输入经真实 encoder 构造；legacy single/batch production shape（含 reason）
 *   仍可读；malformed wire 由 decoder 抛 typed error（不再 JSON parse 后逐项静默
 *   filter / 不再 fallback single / 不再伪造 (unknown) / (no reason given)）。
 */


/** typed ref → v1 wire（经真实 owner encoder；production from 固定 system）。 */
function v1CancelledMeta(refs: readonly { claw: string; contract: string }[]): Record<string, string> {
  const typedRefs: ContractCancelledGuidanceRef[] = refs.map(r => ({
    clawId: makeClawId(r.claw),
    contractId: makeContractId(r.contract),
  }));
  return { ...encodeContractCancelledGuidance(typedRefs) };
}

describe('phase 63+190+198 + phase 1262: contract_cancelled composer', () => {
  it('v1 single（真实 encoder）→ 输出 trace + show CLI block、0 prescription', () => {
    const result = contractCancelledComposer(env('contract_cancelled', v1CancelledMeta([{ claw: 'worker', contract: 'c1' }]), 'system'));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw worker trace --contract c1');
    expect(text).toContain('chestnut contract show -c worker --contract c1');
    // 三段式已删
    expect(text).not.toContain('事实:');
    expect(text).not.toContain('系统已做');
    expect(text).not.toContain('相关基础设施');
    // 0 prescription 严格守
    expect(text).not.toMatch(/建议|推荐|应该|必须|优先|按.*优先级/);
  });

  it('v1 batch（真实 encoder 2 refs）→ enumerate trace + show per ref', () => {
    const result = contractCancelledComposer(env('contract_cancelled', v1CancelledMeta([
      { claw: 'claw1', contract: 'c1' },
      { claw: 'claw2', contract: 'c2' },
    ]), 'system'));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw claw1 trace --contract c1');
    expect(text).toContain('chestnut contract show -c claw2 --contract c2');
  });

  it('v1 batch 超 10 entry 截断显示 + 标 count', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ claw: `claw${i}`, contract: `c${i}` }));
    const result = contractCancelledComposer(env('contract_cancelled', v1CancelledMeta(refs), 'system'));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('(12 cancellations、显示前 10)');
    expect(text).toContain('claw0');
    expect(text).toContain('claw9');
    expect(text).not.toContain('claw10'); // 截断
  });

  it('legacy single（source_claw + contract_id + reason）→ 同 v1 single 输出（reason 不渲染）', () => {
    const result = contractCancelledComposer(env('contract_cancelled', {
      source_claw: 'worker',
      contract_id: 'c1',
      reason: 'user reason',
    }, 'system'));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw worker trace --contract c1');
    expect(text).toContain('chestnut contract show -c worker --contract c1');
  });

  it('legacy batch（cancellations 1 entry）→ 同 v1 输出', () => {
    const result = contractCancelledComposer(env('contract_cancelled', {
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
      ]),
    }, 'system'));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw claw1 trace --contract c1');
    expect(text).toContain('chestnut contract show -c claw1 --contract c1');
  });

  it('legacy batch（2 entries）→ enumerate trace + show per entry', () => {
    const result = contractCancelledComposer(env('contract_cancelled', {
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
        { source_claw: 'claw2', contract_id: 'c2', reason: 'r2' },
      ]),
    }, 'system'));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('claw1');
    expect(text).toContain('c2');
    expect(text).toContain('chestnut contract show -c claw2 --contract c2');
  });

  it('legacy batch 超 10 entry 同 cap 截断', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      source_claw: `claw${i}`,
      contract_id: `c${i}`,
      reason: `r${i}`,
    }));
    const result = contractCancelledComposer(env('contract_cancelled', { cancellations: JSON.stringify(entries) }, 'system'));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('(12 cancellations、显示前 10)');
    expect(text).toContain('claw0');
    expect(text).not.toContain('claw10'); // 截断
  });

  it('phase 1262: legacy bad JSON → decoder typed throw（不再 fallback single / 兜底）', () => {
    expect(() => contractCancelledComposer(env('contract_cancelled', { cancellations: 'not-json' }, 'system')))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262: legacy valid+invalid batch → decoder typed throw（不再部分渲染）', () => {
    expect(() => contractCancelledComposer(env('contract_cancelled', {
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
        { source_claw: 'claw2', contract_id: 'c2' },
      ]),
    }, 'system'))).toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262: legacy single 缺 source_claw → decoder typed throw（不再生成 (unknown) CLI）', () => {
    expect(() => contractCancelledComposer(env('contract_cancelled', { contract_id: 'c1', reason: 'r1' }, 'system')))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262: legacy single 缺 reason → decoder typed throw（不再默认 (no reason given)）', () => {
    expect(() => contractCancelledComposer(env('contract_cancelled', { source_claw: 'worker', contract_id: 'c1' }, 'system')))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });

  it('phase 1262: 空 state → decoder typed throw（缺 version 且无任一 legacy owner key）', () => {
    expect(() => contractCancelledComposer(env('contract_cancelled', {}, 'system')))
      .toThrowError(ContractCancelledGuidanceDecodeError);
  });
});

/**
 * phase 1487 γ5: contract-events real composer unit test.
 * phase 205: 3 旁路删 + 主路精简（state-driven CLI block + 兜底 <unknown>）
 * phase 1261 Step B: composer 只消费 ContractSystem owner codec typed state —
 *   v1 输入经真实 encoder 构造；legacy single/batch production shape 仍可读；
 *   malformed wire 由 decoder 抛 typed error（不再逐项静默过滤 / 不再返部分结果）。
 */


/** typed ref → v1 wire（经真实 owner encoder；production from 固定 system）。 */
function v1EventsMeta(refs: readonly { claw: string; contract: string }[]): Record<string, string> {
  const typedRefs: ContractEventGuidanceRef[] = refs.map(r => ({
    clawId: makeClawId(r.claw),
    contractId: makeContractId(r.contract),
  }));
  return { ...encodeContractEventsGuidance(typedRefs) };
}

describe('phase 205 + phase 1261: contract-events composer', () => {
  it('v1 single（真实 encoder）→ trace + show', () => {
    const result = contractEventsComposer(env('contract_events', v1EventsMeta([{ claw: 'motion', contract: 'abc-123' }]), 'system'));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('motion', 'trace')} --contract abc-123`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c motion --contract abc-123`);
  });

  it('v1 batch（真实 encoder 2 refs）→ enumerate trace + show per ref', () => {
    const result = contractEventsComposer(env('contract_events', v1EventsMeta([
      { claw: 'worker-1', contract: '1780-abcd' },
      { claw: 'worker-2', contract: '1780-cdef' },
    ]), 'system'));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('worker-1', 'trace')} --contract 1780-abcd`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-1 --contract 1780-abcd`);
    expect(result!.text).toContain(`${renderClawInvocation('worker-2', 'trace')} --contract 1780-cdef`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-2 --contract 1780-cdef`);
  });

  it('phase 1261: v1 空 refs → null（observer 正文覆盖全部 completed events、无失败契约；不追加 CLI guidance）', () => {
    const result = contractEventsComposer(env('contract_events', v1EventsMeta([]), 'system'));
    expect(result).toBeNull();
  });

  it('legacy single（source_claw + contract_id）→ 同 v1 single 输出', () => {
    const result = contractEventsComposer(env('contract_events', { source_claw: 'motion', contract_id: 'abc-123' }, 'system'));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('motion', 'trace')} --contract abc-123`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c motion --contract abc-123`);
  });

  it('legacy batch（problem_pairs 1 pair）→ 同 v1 输出', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: 'worker-1:1780-abcd' }, 'system'));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('worker-1', 'trace')} --contract 1780-abcd`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-1 --contract 1780-abcd`);
  });

  it('legacy batch（2 pairs）→ enumerate trace + show per pair', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: 'worker-1:1780-abcd,worker-2:1780-cdef' }, 'system'));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('worker-1', 'trace')} --contract 1780-abcd`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-1 --contract 1780-abcd`);
    expect(result!.text).toContain(`${renderClawInvocation('worker-2', 'trace')} --contract 1780-cdef`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-2 --contract 1780-cdef`);
  });

  it('legacy 空 problem_pairs → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: '' }, 'system'));
    expect(result).toBeNull();
  });

  it('legacy batch trims whitespace around pairs', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: ' worker-1:abc , worker-2:def ' }, 'system'));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('worker-1', 'trace')} --contract abc`);
    expect(result!.text).toContain(`${renderClawInvocation('worker-2', 'trace')} --contract def`);
  });

  it('phase 1261: legacy malformed pair → decoder typed throw（不再跳过坏项保留其余）', () => {
    expect(() => contractEventsComposer(env('contract_events', { problem_pairs: 'malformed,worker-1:1780-abcd' }, 'system')))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });

  it('phase 1261: legacy all malformed pairs → decoder typed throw（不再返 null）', () => {
    expect(() => contractEventsComposer(env('contract_events', { problem_pairs: 'malformed1,malformed2' }, 'system')))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });

  it('phase 1261: legacy single 缺 contract_id → decoder typed throw（不再返 null）', () => {
    expect(() => contractEventsComposer(env('contract_events', { source_claw: 'motion' }, 'system')))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });

  it('phase 1261: 空 state → decoder typed throw（缺 version 且无任一 legacy owner key）', () => {
    expect(() => contractEventsComposer(env('contract_events', {}, 'system')))
      .toThrowError(ContractEventsGuidanceDecodeError);
  });

  it('caps at MAX_PAIR_RENDER=10 and shows overflow hint（v1 真实 encoder）', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ claw: `worker-${i}`, contract: `c${i}` }));
    const result = contractEventsComposer(env('contract_events', v1EventsMeta(refs), 'system'));
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
    const result = contractEventsComposer(env('contract_events', { problem_pairs: pairs }, 'system'));
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(12 contract events、显示前 10)');
    expect(result!.text).toContain('worker-0');
    expect(result!.text).toContain('worker-9');
    expect(result!.text).not.toContain('worker-10');
    expect(result!.text).not.toContain('worker-11');
  });
});

