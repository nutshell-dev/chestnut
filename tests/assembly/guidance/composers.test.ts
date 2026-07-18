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
import { CLAW_VERBS, CONTRACT_COMMANDS } from '../../../src/cli/utils/cli-commands.js';

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
      const r = taskQueueOverflowComposer({ cap: '1000', queue_length: '1000' });
      expect(r.text).toContain('system-level overload');
      expect(r.text).toContain('Surface to the user');
      expect(r.text).toContain('developer');
      expect(r.text).toContain('Do not retry');
    });

    it('returns same guidance regardless of state fields', () => {
      const r1 = taskQueueOverflowComposer({});
      const r2 = taskQueueOverflowComposer({ cap: '500', queue_length: '500' });
      expect(r1.text).toBe(r2.text);
    });
  });
});

describe('claw-outbox-summary-composer', () => {
  /**
   * phase 1476: claw-outbox-summary composer unit test (γ2 first real composer).
   */

  describe('phase 1476: claw-outbox-summary composer', () => {
    it('returns non-null guidance with subject-first CLI', () => {
      const result = clawOutboxSummaryComposer({
        hash: 'abc123def456',
        total_claws: '2',
        total_msgs: '4',
        counts: JSON.stringify({ clawA: 3, clawB: 1 }),
      });
      expect(result.text).toContain('chestnut claw <claw-id> outbox');
      expect(result.text).toContain('--limit 4');
    });

    it('safe limit fallback if total_msgs is malformed', () => {
      const result = clawOutboxSummaryComposer({
        hash: 'aaaaaaaaaaaa',
        total_claws: '1',
        total_msgs: 'NaN',
        counts: '{}',
      });
      expect(result.text).toContain('--limit 10');
    });

    it('total_msgs = 0 still returns guidance (caller decides to call or not)', () => {
      // composer is pure / doesn't second-guess scheduler — tick handler guards 0-unread case
      const result = clawOutboxSummaryComposer({
        hash: 'aaaaaaaaaaaa',
        total_claws: '0',
        total_msgs: '0',
        counts: '{}',
      });
      expect(result.text).toContain('--limit 10'); // fallback when limit <= 0
    });
  });
});

/**
 * phase 2 γ4 + phase 4 重写 + phase 201: claw-crashed real composer unit test.
 * phase 201: unknown → fallback guidance / active_user_stopped → read-only inspect guidance.
 */


describe('claw-crashed composer', () => {
  it('active_unexpected → 2-line guidance: restart + diagnostic CLI (phase 4)', () => {
    const r = clawCrashedComposer({ crash_class: 'active_unexpected', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To restart: chestnut claw clawA daemon');
    expect(r.text).toContain('To inspect what the claw was doing before crash: chestnut claw clawA steps');
  });

  it('active_user_stopped → read-only inspect guidance (status + steps)、不附 restart 暗示 (phase 201)', () => {
    const r = clawCrashedComposer({ crash_class: 'active_user_stopped', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To check current status: chestnut claw clawA status');
    expect(r.text).toContain('To inspect what the claw was doing: chestnut claw clawA steps');
    expect(r.text).not.toContain('daemon');
  });

  it('unknown crash_class → fallback guidance (phase 201 删 null 旁路)', () => {
    const r = clawCrashedComposer({ crash_class: 'mystery', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect: chestnut claw clawA steps');
  });

  it('missing claw_id → fallback <claw-id> placeholder', () => {
    const r = clawCrashedComposer({ crash_class: 'active_unexpected', claw_id: '' });
    expect(r.text).toContain('chestnut claw <claw-id> daemon');
    expect(r.text).toContain('chestnut claw <claw-id> steps');
  });
});

/**
 * phase 1482 + phase 2 reframe + phase 4 重写 + phase 201: claw-inactivity real composer unit test.
 * daemon_stopped case 已移除（归 claw_crashed composer 覆盖）.
 * phase 4: guidance 字面英文化.
 * phase 201: unknown class 改 fallback guidance（非 null）.
 */


describe('claw-inactivity composer', () => {
  it('daemon_silent → STEPS CLI (English)', () => {
    const r = clawInactivityComposer({ failure_class: 'daemon_silent', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect what the agent is stuck on: chestnut claw clawA steps');
  });

  it('daemon_errored → STEPS CLI (English)', () => {
    const r = clawInactivityComposer({ failure_class: 'daemon_errored', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect: chestnut claw clawA steps');
  });

  it('daemon_stopped → fallback guidance (phase 2 移出归 claw_crashed composer、phase 201 unknown 不静默)', () => {
    const r = clawInactivityComposer({ failure_class: 'daemon_stopped', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect: chestnut claw clawA steps');
    expect(r.text).toContain('To be notified if it remains stuck after intervention: chestnut claw clawA watch --inactive-after 5m');
  });

  it('unknown failure_class → fallback guidance (phase 201 删 null 旁路)', () => {
    const r = clawInactivityComposer({ failure_class: 'mystery_class', claw_id: 'clawA' });
    expect(r).not.toBeNull();
    expect(r.text).toContain('To inspect: chestnut claw clawA steps');
    expect(r.text).toContain('To be notified if it remains stuck after intervention: chestnut claw clawA watch --inactive-after 5m');
  });

  it('missing claw_id (daemon_silent) → fallback <claw-id> placeholder', () => {
    const r = clawInactivityComposer({ failure_class: 'daemon_silent', claw_id: '' });
    expect(r.text).toContain('chestnut claw <claw-id> steps');
  });
});

/**
 * phase 63 γ NEW: contract_cancelled composer unit test
 * phase 190: 删 null 旁路 + 加 batch / fallback case
 * phase 198: 改最小 state-driven CLI block（trace + show）
 */


describe('phase 63+190+198: contract_cancelled composer', () => {
  it('输出 trace + show CLI block、0 prescription', () => {
    const result = contractCancelledComposer({
      source_claw: 'worker',
      contract_id: 'c1',
      reason: 'user reason',
    });
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
    const result = contractCancelledComposer({ contract_id: 'c1' });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw (unknown) trace --contract c1');
    expect(text).toContain('chestnut contract show -c (unknown) --contract c1');
  });

  it('phase 190: observer 路径无 contract_id 但有 cancellations → batch 渲染', () => {
    const result = contractCancelledComposer({
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
      ]),
    });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw claw1 trace --contract c1');
    expect(text).toContain('chestnut contract show -c claw1 --contract c1');
  });

  it('phase 190: batch 多 entry 渲染', () => {
    const result = contractCancelledComposer({
      cancellations: JSON.stringify([
        { source_claw: 'claw1', contract_id: 'c1', reason: 'r1' },
        { source_claw: 'claw2', contract_id: 'c2', reason: 'r2' },
      ]),
    });
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
    const result = contractCancelledComposer({ cancellations: JSON.stringify(entries) });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('(12 cancellations、显示前 10)');
    expect(text).toContain('claw0');
    expect(text).not.toContain('claw10'); // 截断
  });

  it('phase 190: cancellations 非法 JSON 时 fallback 到 single entry 或兜底', () => {
    const result = contractCancelledComposer({ contract_id: 'c1', source_claw: 'worker', reason: 'bad json fallback', cancellations: 'not-json' });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw worker trace --contract c1');
    expect(text).toContain('chestnut contract show -c worker --contract c1');
  });

  // phase 366 L3 (review-2026-06-13): 空 state 改返 null、不再渲染 '<unknown>' 字面
  it('phase 366 L3: 空 state 返 null、不渲染 <unknown> 字面 CLI block', () => {
    const result = contractCancelledComposer({});
    expect(result).toBeNull();
  });
});

/**
 * phase 1487 γ5: contract-events real composer unit test.
 * phase 205: 3 旁路删 + 主路精简（state-driven CLI block + 兜底 <unknown>）
 */


describe('phase 205: contract-events composer', () => {
  it('A3 single path (source_claw + contract_id) → trace + show', () => {
    const result = contractEventsComposer({ source_claw: 'motion', contract_id: 'abc-123' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`chestnut claw motion ${CLAW_VERBS.TRACE} --contract abc-123`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c motion --contract abc-123`);
  });

  // phase 366 L3 (review-2026-06-13): 缺关键字段改返 null、不再渲染 '<unknown>' 字面
  it('phase 366 L3: A3 path without contract_id → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer({ source_claw: 'motion' });
    expect(result).toBeNull();
  });

  it('A4 batch path (1 pair) → trace + show with real ids', () => {
    const result = contractEventsComposer({ problem_pairs: 'worker-1:1780-abcd' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`chestnut claw worker-1 ${CLAW_VERBS.TRACE} --contract 1780-abcd`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-1 --contract 1780-abcd`);
  });

  it('A4 batch path (2 pairs) → enumerate trace + show per pair', () => {
    const result = contractEventsComposer({ problem_pairs: 'worker-1:1780-abcd,worker-2:1780-cdef' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`chestnut claw worker-1 ${CLAW_VERBS.TRACE} --contract 1780-abcd`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-1 --contract 1780-abcd`);
    expect(result!.text).toContain(`chestnut claw worker-2 ${CLAW_VERBS.TRACE} --contract 1780-cdef`);
    expect(result!.text).toContain(`${CONTRACT_COMMANDS.SHOW} -c worker-2 --contract 1780-cdef`);
  });

  it('phase 366 L3: empty state → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer({});
    expect(result).toBeNull();
  });

  it('phase 366 L3: empty problem_pairs → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer({ problem_pairs: '' });
    expect(result).toBeNull();
  });

  it('malformed pair (no colon) → skipped, others kept', () => {
    const result = contractEventsComposer({ problem_pairs: 'malformed,worker-1:1780-abcd' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`chestnut claw worker-1 ${CLAW_VERBS.TRACE} --contract 1780-abcd`);
    expect(result!.text).not.toContain('malformed');
  });

  it('phase 366 L3: all malformed pairs → null（不渲染 <unknown>）', () => {
    const result = contractEventsComposer({ problem_pairs: 'malformed1,malformed2' });
    expect(result).toBeNull();
  });

  it('trims whitespace around pairs', () => {
    const result = contractEventsComposer({ problem_pairs: ' worker-1:abc , worker-2:def ' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`chestnut claw worker-1 ${CLAW_VERBS.TRACE} --contract abc`);
    expect(result!.text).toContain(`chestnut claw worker-2 ${CLAW_VERBS.TRACE} --contract def`);
  });

  it('caps at MAX_PAIR_RENDER=10 and shows overflow hint', () => {
    const pairs = Array.from({ length: 12 }, (_, i) => `worker-${i}:c${i}`).join(',');
    const result = contractEventsComposer({ problem_pairs: pairs });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(12 contract events、显示前 10)');
    // 只应出现前 10 个
    expect(result!.text).toContain('worker-0');
    expect(result!.text).toContain('worker-9');
    expect(result!.text).not.toContain('worker-10');
    expect(result!.text).not.toContain('worker-11');
  });
});

