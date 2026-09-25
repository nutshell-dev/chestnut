/**
 * phase 1909 Step C（M16）：runtime 提示词段字面语义验收。
 *
 * 机械迁移（逐字节不变），本测试只锁结构要素：
 *  1. 段头/标签字面齐备（Active Contract / Memory / Title / Goal / Subtasks）
 *  2. 子任务行：done 两态复选框 + id + 描述；done 由调用方判断，模板不自判状态
 */

import { describe, it, expect } from 'vitest';
import {
  ACTIVE_CONTRACT_SECTION_HEADING,
  MEMORY_SECTION_HEADING,
  CONTRACT_TITLE_LABEL,
  CONTRACT_GOAL_LABEL,
  CONTRACT_SUBTASKS_LABEL,
  contractSubtaskLine,
} from '../../../src/templates/messages/index.js';

describe('phase 1909: runtime 提示词段字面（M16）', () => {
  it('段头与标签字面齐备', () => {
    expect(ACTIVE_CONTRACT_SECTION_HEADING).toBe('## Active Contract');
    expect(MEMORY_SECTION_HEADING).toBe('## Memory');
    expect(CONTRACT_TITLE_LABEL).toBe('**Title:**');
    expect(CONTRACT_GOAL_LABEL).toBe('**Goal:**');
    expect(CONTRACT_SUBTASKS_LABEL).toBe('**Subtasks:**');
  });

  it('子任务行：done 两态复选框 + 反引号 id + 描述', () => {
    expect(contractSubtaskLine(true, 'design', 'Design API')).toBe('[x] `design`: Design API');
    expect(contractSubtaskLine(false, 'impl', 'Implement')).toBe('[ ] `impl`: Implement');
  });

  it('子任务行原样透传 id/描述（模板不改写、不补造）', () => {
    const line = contractSubtaskLine(false, 's-1', 'desc with "quotes"');
    expect(line).toContain('s-1');
    expect(line).toContain('desc with "quotes"');
  });
});
