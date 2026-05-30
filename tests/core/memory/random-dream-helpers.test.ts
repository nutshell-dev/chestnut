/**
 * phase 1467 — memory-system test cov 补强 (F9 from audit-2026-05-30)
 *
 * 覆盖 random-dream.ts `extractDreamOutputs` 正则解析 helper:
 * 从 sub-agent log 提取 [DREAM_OUTPUT contract_id="..."]...[/DREAM_OUTPUT] 块。
 *
 * scope 严守：仅 helper unit tests / 不动 runRandomDream public API surface
 */
import { describe, it, expect } from 'vitest';
import { __test_extractDreamOutputs } from '../../../src/core/memory/random-dream.js';

describe('random-dream extractDreamOutputs (phase 1467)', () => {
  it('empty log returns empty arrays', () => {
    const r = __test_extractDreamOutputs('');
    expect(r.outputs).toEqual([]);
    expect(r.contractIds).toEqual([]);
  });

  it('log without DREAM_OUTPUT tags returns empty', () => {
    const r = __test_extractDreamOutputs('some random log without tags\n[OTHER_TAG]nope[/OTHER_TAG]');
    expect(r.outputs).toEqual([]);
    expect(r.contractIds).toEqual([]);
  });

  it('single DREAM_OUTPUT extracted', () => {
    const log = `prelude\n[DREAM_OUTPUT contract_id="c-abc-123"]Lesson learned: be careful with locks.[/DREAM_OUTPUT]\nepilogue`;
    const r = __test_extractDreamOutputs(log);
    expect(r.contractIds).toEqual(['c-abc-123']);
    expect(r.outputs).toEqual(['Lesson learned: be careful with locks.']);
  });

  it('multiple DREAM_OUTPUT blocks extracted in order', () => {
    const log = [
      '[DREAM_OUTPUT contract_id="c-1"]first lesson[/DREAM_OUTPUT]',
      'noise between',
      '[DREAM_OUTPUT contract_id="c-2"]second lesson[/DREAM_OUTPUT]',
      '[DREAM_OUTPUT contract_id="c-3"]third lesson[/DREAM_OUTPUT]',
    ].join('\n');
    const r = __test_extractDreamOutputs(log);
    expect(r.contractIds).toEqual(['c-1', 'c-2', 'c-3']);
    expect(r.outputs).toEqual(['first lesson', 'second lesson', 'third lesson']);
  });

  it('multiline content within tags preserved (trim only outer whitespace)', () => {
    const log = `[DREAM_OUTPUT contract_id="c-multi"]
line 1
line 2

line 4 with blank above
[/DREAM_OUTPUT]`;
    const r = __test_extractDreamOutputs(log);
    expect(r.contractIds).toEqual(['c-multi']);
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs[0]).toBe('line 1\nline 2\n\nline 4 with blank above');
  });

  it('contract_id with hyphens/digits/uuid-like chars captured', () => {
    const log = `[DREAM_OUTPUT contract_id="contract-abc-12345-deadbeef"]x[/DREAM_OUTPUT]`;
    const r = __test_extractDreamOutputs(log);
    expect(r.contractIds).toEqual(['contract-abc-12345-deadbeef']);
  });

  it('malformed tag (missing close) does not match (regex requires closing)', () => {
    const log = `[DREAM_OUTPUT contract_id="c-unclosed"]content without close`;
    const r = __test_extractDreamOutputs(log);
    expect(r.contractIds).toEqual([]);
    expect(r.outputs).toEqual([]);
  });

  it('nested-looking text inside content matches non-greedy outermost block (first close wins)', () => {
    const log = `[DREAM_OUTPUT contract_id="c-1"]outer1[DREAM_OUTPUT contract_id="ignored"]inner[/DREAM_OUTPUT]outer2[/DREAM_OUTPUT]`;
    const r = __test_extractDreamOutputs(log);
    // Non-greedy *? on content closes at first [/DREAM_OUTPUT] occurrence after opening
    expect(r.contractIds).toEqual(['c-1']);
    expect(r.outputs).toEqual(['outer1[DREAM_OUTPUT contract_id="ignored"]inner']);
  });
});
