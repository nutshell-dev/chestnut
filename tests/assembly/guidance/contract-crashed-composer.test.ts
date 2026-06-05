/**
 * phase 63 γ NEW: contract_crashed composer unit test
 */

import { describe, it, expect } from 'vitest';
import { composer } from '../../../src/assembly/guidance/composers/contract-crashed.js';

describe('phase 63: contract_crashed composer', () => {
  it('observer 路径无 contract_id → null', () => {
    expect(composer({})).toBeNull();
  });

  it('含必备字段 + 0 prescription', () => {
    const result = composer({
      source_claw: 'worker',
      contract_id: 'c1',
      cause: 'system: maxstepsexceedederror',
    });
    expect(result).not.toBeNull();
    const text = result!.text;
    expect(text).toContain('[contract_crashed]');
    expect(text).toContain('事实:');
    expect(text).toContain('系统已做:');
    expect(text).toContain('相关基础设施:');
    expect(text).toContain('worker');
    expect(text).toContain('system: maxstepsexceedederror');
    expect(text).toContain('chestnut contract');
    expect(text).toContain('daemon 仍活着');
    // 0 prescription 严格守
    expect(text).not.toMatch(/建议|推荐|应该|必须|优先|按.*优先级/);
  });

  it('缺 cause 时显示 (no cause given)', () => {
    const result = composer({ contract_id: 'c1' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('(no cause given)');
  });
});
