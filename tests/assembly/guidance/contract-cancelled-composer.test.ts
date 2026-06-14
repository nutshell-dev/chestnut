/**
 * phase 63 γ NEW: contract_cancelled composer unit test
 * phase 190: 删 null 旁路 + 加 batch / fallback case
 * phase 198: 改最小 state-driven CLI block（trace + show）
 */

import { describe, it, expect } from 'vitest';
import { composer } from '../../../src/assembly/guidance/composers/contract-cancelled.js';

describe('phase 63+190+198: contract_cancelled composer', () => {
  it('输出 trace + show CLI block、0 prescription', () => {
    const result = composer({
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
    const result = composer({ contract_id: 'c1' });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw (unknown) trace --contract c1');
    expect(text).toContain('chestnut contract show -c (unknown) --contract c1');
  });

  it('phase 190: observer 路径无 contract_id 但有 cancellations → batch 渲染', () => {
    const result = composer({
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
    const result = composer({
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
    const result = composer({ cancellations: JSON.stringify(entries) });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('(12 cancellations、显示前 10)');
    expect(text).toContain('claw0');
    expect(text).not.toContain('claw10'); // 截断
  });

  it('phase 190: cancellations 非法 JSON 时 fallback 到 single entry 或兜底', () => {
    const result = composer({ contract_id: 'c1', source_claw: 'worker', reason: 'bad json fallback', cancellations: 'not-json' });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('chestnut claw worker trace --contract c1');
    expect(text).toContain('chestnut contract show -c worker --contract c1');
  });

  // phase 366 L3 (review-2026-06-13): 空 state 改返 null、不再渲染 '<unknown>' 字面
  it('phase 366 L3: 空 state 返 null、不渲染 <unknown> 字面 CLI block', () => {
    const result = composer({});
    expect(result).toBeNull();
  });
});
