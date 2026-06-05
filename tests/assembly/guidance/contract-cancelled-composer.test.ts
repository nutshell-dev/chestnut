/**
 * phase 63 γ NEW: contract_cancelled composer unit test
 */

import { describe, it, expect } from 'vitest';
import { composer } from '../../../src/assembly/guidance/composers/contract-cancelled.js';

describe('phase 63: contract_cancelled composer', () => {
  it('observer 路径无 contract_id → null', () => {
    expect(composer({})).toBeNull();
  });

  it('含必备字段 + 0 prescription', () => {
    const result = composer({
      source_claw: 'worker',
      contract_id: 'c1',
      reason: 'user reason',
    });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('[contract_cancelled]');
    expect(text).toContain('事实:');
    expect(text).toContain('系统已做:');
    expect(text).toContain('相关基础设施:');
    expect(text).toContain('worker');
    expect(text).toContain('user reason');
    expect(text).toContain('chestnut contract');
    // 0 prescription 严格守
    expect(text).not.toMatch(/建议|推荐|应该|必须|优先|按.*优先级/);
  });

  it('缺 reason 时显示 (no reason given)', () => {
    const result = composer({ contract_id: 'c1' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(no reason given)');
  });
});
