/**
 * Phase 270 Step A: subagent steps.jsonl shape invariant tests
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertStepsEntryShape } from '../../../src/core/subagent/invariants.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';

function makeMockAudit() {
  return {
    write: vi.fn(),
  };
}

describe('subagent steps.jsonl shape invariant (phase 270 Step A)', () => {
  describe('entry root check', () => {
    it('entry=null → emit kind=entry_not_object', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape(null, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0][0]).toBe(SUBAGENT_AUDIT_EVENTS.SUBAGENT_STEPS_INVARIANT_VIOLATED);
      expect(audit.write.mock.calls[0]).toContain('kind=entry_not_object');
      expect(audit.write.mock.calls[0]).toContain('agentId=a1');
    });

    it('entry=42 → emit kind=entry_not_object', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape(42, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0][0]).toBe(SUBAGENT_AUDIT_EVENTS.SUBAGENT_STEPS_INVARIANT_VIOLATED);
      expect(audit.write.mock.calls[0]).toContain('kind=entry_not_object');
    });

    it('entry=string → emit kind=entry_not_object', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape('bad', audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=entry_not_object');
    });
  });

  describe('step', () => {
    it('合法非负整数 → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 1, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('0 → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('负数 → emit kind=step_invalid', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: -1, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0][0]).toBe(SUBAGENT_AUDIT_EVENTS.SUBAGENT_STEPS_INVARIANT_VIOLATED);
      expect(audit.write.mock.calls[0]).toContain('kind=step_invalid');
    });

    it('小数 → emit kind=step_invalid', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 1.5, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=step_invalid');
    });

    it('字符串 → emit kind=step_invalid', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: '1', ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=step_invalid');
    });
  });

  describe('ts', () => {
    it('合法 ISO → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('带毫秒 ISO → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00.123Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('带时区偏移 ISO → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00+08:00', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('非 string → emit kind=ts_not_string', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: 123, tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=ts_not_string');
    });

    it('错格式 "2026-01-01" → emit kind=ts_not_iso', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=ts_not_iso');
    });
  });

  describe('tools', () => {
    it('合法 string[] → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: ['a', 'b'], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('空数组 → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('非数组 → emit kind=tools_not_array', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: 'tool', elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=tools_not_array');
    });

    it('含非 string → emit kind=tools_element_not_string + idx', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: ['a', 2], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=tools_element_not_string');
      expect(audit.write.mock.calls[0]).toContain('idx=1');
    });
  });

  describe('elapsedMs', () => {
    it('非负整数 → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 100 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('0 → 0 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('负数 → emit kind=elapsedMs_invalid', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: -1 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=elapsedMs_invalid');
    });

    it('小数 → emit kind=elapsedMs_invalid', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 1.5 }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=elapsedMs_invalid');
    });

    it('字符串 → emit kind=elapsedMs_invalid', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: '2026-01-01T00:00:00Z', tools: [], elapsedMs: 'fast' }, audit as any, 'a1');
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0]).toContain('kind=elapsedMs_invalid');
    });
  });

  describe('multiple violations', () => {
    it('多字段同时非法 → 各独立 emit', () => {
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: -1, ts: 'bad', tools: [1], elapsedMs: -1 }, audit as any, 'a1');
      const calls = audit.write.mock.calls;
      expect(calls.length).toBe(4);
      const kinds = calls.map((c: any[]) => c.find((x: string) => x?.startsWith('kind=')));
      expect(kinds).toContain('kind=step_invalid');
      expect(kinds).toContain('kind=ts_not_iso');
      expect(kinds).toContain('kind=tools_element_not_string');
      expect(kinds).toContain('kind=elapsedMs_invalid');
    });
  });

  describe('onStepComplete integration', () => {
    it('合法 entry → 0 emit + 文件 append 行', async () => {
      // covered by agent.ts existing tests; here we just assert invariant function contract
      const audit = makeMockAudit();
      assertStepsEntryShape({ step: 0, ts: new Date().toISOString(), tools: [], elapsedMs: 0 }, audit as any, 'a1');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('非法 entry → audit emit + 不 throw', () => {
      const audit = makeMockAudit();
      expect(() => assertStepsEntryShape({ step: 'x' }, audit as any, 'a1')).not.toThrow();
      expect(audit.write).toHaveBeenCalled();
    });
  });
});

describe('phase 1484 Step B: run.ts must not define MainContextSnapshot', () => {
  it('run.ts 不得包含 MainContextSnapshot interface 定义', () => {
    const src = readFileSync('src/core/subagent/run.ts', 'utf-8');
    expect(src).not.toMatch(/export\s+interface\s+MainContextSnapshot\b/);
  });
});
