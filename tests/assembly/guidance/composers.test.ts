/**
 * Guidance composer tests — mechanical merge; assertion logic unchanged.
 * Phase 1091: six fast test files consolidated to reduce per-file scheduling cost.
 */

import { describe, it, expect } from 'vitest';
import { composer as taskQueueOverflowComposer } from '../../../src/assembly/guidance/composers/task-queue-overflow.js';
import { composer as clawOutboxSummaryComposer } from '../../../src/assembly/guidance/composers/claw-outbox-summary.js';
import { composer as clawCrashedComposer } from '../../../src/assembly/guidance/composers/claw-crashed.js';
import { composer as clawInactivityComposer } from '../../../src/assembly/guidance/composers/claw-inactivity.js';
import { composer as contractCancelledComposer } from '../../../src/assembly/guidance/composers/contract-cancelled.js';
import { composer as contractEventsComposer } from '../../../src/assembly/guidance/composers/contract-events.js';
import { renderClawInvocation, CONTRACT_COMMANDS } from '../../../src/cli-protocol/index.js';
import { ClawCrashedGuidanceDecodeError } from '../../../src/watchdog/claw-crashed-guidance.js';
import { ClawInactivityGuidanceDecodeError } from '../../../src/watchdog/claw-inactivity-guidance.js';
import { OutboxSummaryGuidanceDecodeError } from '../../../src/core/claw-topology/jobs/outbox-summary/guidance-state.js';

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
 * phase 2 γ4 + phase 4 重写 + phase 201 + phase 1257 Step B: claw-crashed real composer unit test.
 * phase 1257 Step B: composer 只消费 Watchdog owner codec typed state —
 *   真实 envelope `from` 成 CLI target（不再读不存在的 meta.claw_id / 不再产 `<claw-id>`）；
 *   unknown class / 缺字段 / 空 from 由 decoder 抛 typed error（不再产 fallback guidance）。
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

describe('claw-crashed composer', () => {
  it('active_unexpected v1 → 2-line guidance: restart + diagnostic CLI, target = envelope from (phase 4)', () => {
    const r = clawCrashedComposer(env('claw_crashed', v1CrashMeta('active_unexpected'), 'claw-real'));
    expect(r).not.toBeNull();
    expect(r.text).toContain('To restart: chestnut claw claw-real daemon');
    expect(r.text).toContain('To inspect what the claw was doing before crash: chestnut claw claw-real steps');
  });

  it('active_unexpected legacy production shape → 同 v1 输出（version 缺失不影哂）', () => {
    const r = clawCrashedComposer(env('claw_crashed', legacyCrashMeta('active_unexpected'), 'claw-real'));
    expect(r).not.toBeNull();
    expect(r.text).toContain('To restart: chestnut claw claw-real daemon');
    expect(r.text).toContain('To inspect what the claw was doing before crash: chestnut claw claw-real steps');
  });

  it('active_user_stopped → read-only inspect guidance (status + steps)、不附 restart 暗示 (phase 201)', () => {
    const r = clawCrashedComposer(env('claw_crashed', v1CrashMeta('active_user_stopped'), 'claw-real'));
    expect(r).not.toBeNull();
    expect(r.text).toContain('To check current status: chestnut claw claw-real status');
    expect(r.text).toContain('To inspect what the claw was doing: chestnut claw claw-real steps');
    expect(r.text).not.toContain('daemon');
  });

  it('unknown crash_class → decoder throws typed error（不再产 fallback inspect）', () => {
    expect(() => clawCrashedComposer(env('claw_crashed', v1CrashMeta('mystery'), 'claw-real')))
      .toThrowError(ClawCrashedGuidanceDecodeError);
  });

  it('缺 owned field（outbox_pending）→ decoder throws typed error（v1 与 legacy 同）', () => {
    const v1 = v1CrashMeta('active_unexpected');
    delete v1.outbox_pending;
    expect(() => clawCrashedComposer(env('claw_crashed', v1, 'claw-real')))
      .toThrowError(ClawCrashedGuidanceDecodeError);
    const legacy = legacyCrashMeta('active_unexpected');
    delete legacy.outbox_pending;
    expect(() => clawCrashedComposer(env('claw_crashed', legacy, 'claw-real')))
      .toThrowError(ClawCrashedGuidanceDecodeError);
  });

  it('空 from → decoder throws typed error（不再产 <claw-id> placeholder）', () => {
    expect(() => clawCrashedComposer(env('claw_crashed', v1CrashMeta('active_unexpected'), '')))
      .toThrowError(ClawCrashedGuidanceDecodeError);
  });
});

/**
 * phase 1482 + phase 2 reframe + phase 4 重写 + phase 201 + phase 1258 Step B: claw-inactivity real composer unit test.
 * daemon_stopped case 已移除（归 claw_crashed composer 覆盖）.
 * phase 4: guidance 字面英文化.
 * phase 1258 Step B: composer 只消费 Watchdog owner codec typed state —
 *   `claw_id` 来自 owner metadata（envelope from 固定 watchdog = 发起模块业务语义）；
 *   unknown class / 缺字段 / 错 from 由 decoder 抛 typed error（不再产 fallback / `<claw-id>` placeholder）。
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

describe('claw-inactivity composer', () => {
  it('daemon_silent v1 → STEPS CLI (English)', () => {
    const r = clawInactivityComposer(env('claw_inactivity', v1InactivityMeta('daemon_silent'), 'watchdog'));
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect what the agent is stuck on: chestnut claw clawA steps');
  });

  it('daemon_errored v1 → STEPS CLI + watch subscription CLI', () => {
    const r = clawInactivityComposer(env('claw_inactivity', v1InactivityMeta('daemon_errored'), 'watchdog'));
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect: chestnut claw clawA steps');
    expect(r.text).toContain('To be notified if it remains stuck after intervention: chestnut claw clawA watch --inactive-after 5m');
  });

  it('daemon_silent legacy production shape → 同 v1 输出（version 缺失不影响）', () => {
    const r = clawInactivityComposer(env('claw_inactivity', legacyInactivityMeta('daemon_silent'), 'watchdog'));
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect what the agent is stuck on: chestnut claw clawA steps');
  });

  it('subscription production shape（含 source_path + last_error）→ 输出不变（composer 不重灌 body 事实）', () => {
    const r = clawInactivityComposer(env('claw_inactivity', {
      ...v1InactivityMeta('daemon_errored'),
      source_path: 'subscription',
      last_error: 'LLM timeout',
    }, 'watchdog'));
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect: chestnut claw clawA steps');
  });

  it('daemon_stopped → decoder throws typed error（不再产 fallback guidance）', () => {
    expect(() => clawInactivityComposer(env('claw_inactivity', v1InactivityMeta('daemon_stopped'), 'watchdog')))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });

  it('unknown failure_class → decoder throws typed error（不再产 fallback guidance）', () => {
    expect(() => clawInactivityComposer(env('claw_inactivity', v1InactivityMeta('mystery_class'), 'watchdog')))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });

  it('missing claw_id (daemon_silent) → decoder throws typed error（不再产 <claw-id> placeholder）', () => {
    const meta = v1InactivityMeta('daemon_silent');
    delete meta.claw_id;
    expect(() => clawInactivityComposer(env('claw_inactivity', meta, 'watchdog')))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });

  it('from 非 watchdog → decoder throws typed error（owner provenance 不可伪装）', () => {
    expect(() => clawInactivityComposer(env('claw_inactivity', v1InactivityMeta('daemon_silent'), 'clawA')))
      .toThrowError(ClawInactivityGuidanceDecodeError);
  });
});

/**
 * phase 63 γ NEW: contract_cancelled composer unit test
 * phase 190: 删 null 旁路 + 加 batch / fallback case
 * phase 198: 改最小 state-driven CLI block（trace + show）
 */


describe('phase 63+190+198: contract_cancelled composer', () => {
  it('输出 trace + show CLI block、0 prescription', () => {
    const result = contractCancelledComposer(env('contract_cancelled', {
      source_claw: 'worker',
      contract_id: 'c1',
      reason: 'user reason',
    }));
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

  it('缺 reason 时正常输出 CLI block（reason 不渲染）', () => {
    const result = contractCancelledComposer(env('contract_cancelled', { contract_id: 'c1' }));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw (unknown) trace --contract c1');
    expect(text).toContain('chestnut contract show -c (unknown) --contract c1');
  });

  it('phase 190: observer 路径无 contract_id 但有 cancellations → batch 渲染', () => {
    const result = contractCancelledComposer(env('contract_cancelled', {
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
      ]),
    }));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw claw1 trace --contract c1');
    expect(text).toContain('chestnut contract show -c claw1 --contract c1');
  });

  it('phase 190: batch 多 entry 渲染', () => {
    const result = contractCancelledComposer(env('contract_cancelled', {
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
        { source_claw: 'claw2', contract_id: 'c2', reason: 'r2' },
      ]),
    }));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('claw1');
    expect(text).toContain('c2');
    expect(text).toContain('chestnut contract show -c claw2 --contract c2');
  });

  it('phase 190: batch 超 10 entry 截断显示 + 标 count', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      source_claw: `claw${i}`,
      contract_id: `c${i}`,
      reason: `r${i}`,
    }));
    const result = contractCancelledComposer(env('contract_cancelled', { cancellations: JSON.stringify(entries) }));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('(12 cancellations、显示前 10)');
    expect(text).toContain('claw0');
    expect(text).not.toContain('claw10'); // 截断
  });

  it('phase 190: cancellations 非法 JSON 时 fallback 到 single entry 或兜底', () => {
    const result = contractCancelledComposer(env('contract_cancelled', { contract_id: 'c1', source_claw: 'worker', reason: 'bad json fallback', cancellations: 'not-json' }));
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw worker trace --contract c1');
    expect(text).toContain('chestnut contract show -c worker --contract c1');
  });

  // phase 366 L3 (review-2026-06-13): 空 state 改返 null、不再渲染 '<unknown>' 字面
  it('phase 366 L3: 空 state 返 null、不渲染 <unknown> 字面 CLI block', () => {
    const result = contractCancelledComposer(env('contract_cancelled', {}));
    expect(result).toBeNull();
  });
});

/**
 * phase 1487 γ5: contract-events real composer unit test.
 * phase 205: 3 旁路删 + 主路精简（state-driven CLI block + 兜底 <unknown>）
 */


describe('phase 205: contract-events composer', () => {
  it('A3 single path (source_claw + contract_id) → trace + show', () => {
    const result = contractEventsComposer(env('contract_events', { source_claw: 'motion', contract_id: 'abc-123' }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('motion', 'trace')} --contract abc-123`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c motion --contract abc-123`);
  });

  // phase 366 L3 (review-2026-06-13): 缺关键字段改返 null、不再渲染 '<unknown>' 字面
  it('phase 366 L3: A3 path without contract_id → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer(env('contract_events', { source_claw: 'motion' }));
    expect(result).toBeNull();
  });

  it('A4 batch path (1 pair) → trace + show with real ids', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: 'worker-1:1780-abcd' }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('worker-1', 'trace')} --contract 1780-abcd`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-1 --contract 1780-abcd`);
  });

  it('A4 batch path (2 pairs) → enumerate trace + show per pair', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: 'worker-1:1780-abcd,worker-2:1780-cdef' }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('worker-1', 'trace')} --contract 1780-abcd`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-1 --contract 1780-abcd`);
    expect(result!.text).toContain(`${renderClawInvocation('worker-2', 'trace')} --contract 1780-cdef`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-2 --contract 1780-cdef`);
  });

  it('phase 366 L3: empty state → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer(env('contract_events', {}));
    expect(result).toBeNull();
  });

  it('phase 366 L3: empty problem_pairs → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: '' }));
    expect(result).toBeNull();
  });

  it('malformed pair (no colon) → skipped, others kept', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: 'malformed,worker-1:1780-abcd' }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('worker-1', 'trace')} --contract 1780-abcd`);
    expect(result!.text).not.toContain('malformed');
  });

  it('phase 366 L3: all malformed pairs → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: 'malformed1,malformed2' }));
    expect(result).toBeNull();
  });

  it('trims whitespace around pairs', () => {
    const result = contractEventsComposer(env('contract_events', { problem_pairs: ' worker-1:abc , worker-2:def ' }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`${renderClawInvocation('worker-1', 'trace')} --contract abc`);
    expect(result!.text).toContain(`${renderClawInvocation('worker-2', 'trace')} --contract def`);
  });

  it('caps at MAX_PAIR_RENDER=10 and shows overflow hint', () => {
    const pairs = Array.from({ length: 12 }, (_, i) => `worker-${i}:c${i}`).join(',');
    const result = contractEventsComposer(env('contract_events', { problem_pairs: pairs }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(12 contract events、显示前 10)');
    // 只应出现前 10 个
    expect(result!.text).toContain('worker-0');
    expect(result!.text).toContain('worker-9');
    expect(result!.text).not.toContain('worker-10');
    expect(result!.text).not.toContain('worker-11');
  });
});

