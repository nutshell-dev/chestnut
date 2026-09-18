/**
 * Phase 270 Step A: subagent steps.jsonl shape invariant tests
 *
 * phase 1858 Step K (SA-D10): 消费面改 StepsInvariantSink（结构化断言）；
 * 事件字符串 / 列格式由 lifecycle-sink adapter 等价矩阵守（lifecycle-sink-equivalence.test.ts）。
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertStepsEntryShape } from '../../../src/core/subagent/invariants.js';

function makeMockSink() {
  return { stepsInvariantViolated: vi.fn() };
}

describe('subagent steps.jsonl shape invariant (phase 270 Step A)', () => {
  describe('entry root check', () => {
    it('entry=null → kind=entry_not_object', () => {
      const sink = makeMockSink();
      assertStepsEntryShape(null, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'entry_not_object', actual: 'object' });
    });

    it('entry=42 → kind=entry_not_object', () => {
      const sink = makeMockSink();
      assertStepsEntryShape(42, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'entry_not_object', actual: 'number' });
    });

    it('entry=string → kind=entry_not_object', () => {
      const sink = makeMockSink();
      assertStepsEntryShape('bad', sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'entry_not_object', actual: 'string' });
    });
  });

  describe('step', () => {
    it('合法非负整数 → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 1, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('0 → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('负数 → kind=step_invalid', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: -1, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'step_invalid', actual: '-1' });
    });

    it('小数 → kind=step_invalid', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 1.5, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'step_invalid', actual: '1.5' });
    });

    it('字符串 → kind=step_invalid', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: '1', ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'step_invalid', actual: '1' });
    });
  });

  describe('ts', () => {
    it('合法 ISO → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('带毫秒 ISO → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00.123Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('带时区偏移 ISO → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00+08:00', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('非 string → kind=ts_not_string', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: 123, tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'ts_not_string', actual: 'number' });
    });

    it('错格式 "2026-01-01" → kind=ts_not_iso', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'ts_not_iso', actual: '2026-01-01' });
    });
  });

  describe('tools', () => {
    it('合法 string[] → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: ['a', 'b'], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('空数组 → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('非数组 → kind=tools_not_array', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: 'tool', elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'tools_not_array', actual: 'string' });
    });

    it('含非 string → kind=tools_element_not_string + idx', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: ['a', 2], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({
        kind: 'tools_element_not_string',
        idx: 1,
        actual: 'number',
      });
    });
  });

  describe('elapsedMs', () => {
    it('非负整数 → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 100 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('0 → 0 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('负数 → kind=elapsedMs_invalid', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: -1 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'elapsedMs_invalid', actual: '-1' });
    });

    it('小数 → kind=elapsedMs_invalid', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 1.5 }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'elapsedMs_invalid', actual: '1.5' });
    });

    it('字符串 → kind=elapsedMs_invalid', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 'fast' }, sink);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledTimes(1);
      expect(sink.stepsInvariantViolated).toHaveBeenCalledWith({ kind: 'elapsedMs_invalid', actual: 'fast' });
    });
  });

  describe('multiple violations', () => {
    it('多字段同时非法 → 各独立 emit', () => {
      const sink = makeMockSink();
      assertStepsEntryShape({ step: -1, ts: 'bad', tools: [1], elapsedMs: -1 }, sink);
      const calls = sink.stepsInvariantViolated.mock.calls;
      expect(calls).toHaveLength(4);
      const kinds = calls.map((c: [{ kind: string }]) => c[0].kind);
      expect(kinds).toContain('step_invalid');
      expect(kinds).toContain('ts_not_iso');
      expect(kinds).toContain('tools_element_not_string');
      expect(kinds).toContain('elapsedMs_invalid');
    });
  });

  describe('onStepComplete integration', () => {
    it('合法 entry → 0 emit + 文件 append 行', async () => {
      // covered by agent.ts existing tests; here we just assert invariant function contract
      const sink = makeMockSink();
      assertStepsEntryShape({ step: 0, ts: new Date().toISOString(), tools: [], elapsedMs: 0 }, sink);
      expect(sink.stepsInvariantViolated).not.toHaveBeenCalled();
    });

    it('非法 entry → sink emit + 不 throw', () => {
      const sink = makeMockSink();
      expect(() => assertStepsEntryShape({ step: 'x' }, sink)).not.toThrow();
      expect(sink.stepsInvariantViolated).toHaveBeenCalled();
    });
  });
});

describe('phase 1484 Step B: run.ts must not define MainContextSnapshot', () => {
  it('run.ts 不得包含 MainContextSnapshot interface 定义', () => {
    const src = readFileSync('src/core/subagent/run.ts', 'utf-8');
    expect(src).not.toMatch(/export\s+interface\s+MainContextSnapshot\b/);
  });
});
