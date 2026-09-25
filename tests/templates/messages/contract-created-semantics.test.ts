/**
 * phase 1906 Step C：契约创建通知（M12）工具名修正的语义验收。
 *
 * 背景：迁模板单源前，正文指示 claw 用 subagent 专用 done 工具提交验收；claw
 * （tool_profile: 'full'）实际可见的是 submit_subtask。照错名调用会写入无人读取的
 * capture 通道并提前结束本轮，验收从未提交。
 *
 * 本测试只锁工具名、参数字键与结构要素，不锁句式标点（避免把措辞锁死）：
 *  1. 正文指示工具为 submit_subtask，且不再出现 done 工具指示
 *  2. 示例参数键与真实 submit_subtask 工具 schema（required: subtask/evidence）一致
 *  3. 子任务列表逐条呈现（id + description）
 *  4. 缺省字段（background/expectations）省略不补造
 */

import { describe, it, expect } from 'vitest';
import { contractCreatedNotificationBody } from '../../../src/templates/messages/index.js';
import { buildSubmitSubtaskTool } from '../../../src/core/contract/tools/submit-subtask.js';

/** 真实工具 schema（dummy deps；本测试不执行工具，只取静态 schema 定义）。 */
const SUBMIT_SUBTASK_SCHEMA = buildSubmitSubtaskTool({
  loadForeground: async () => null,
  submit: async () => { throw new Error('not executed in this test'); },
}).schema as { properties: Record<string, unknown>; required: string[] };

const FULL_INPUT = {
  contractId: 'c-001',
  title: 'T',
  background: 'B',
  goal: 'G',
  expectations: 'E',
  subtasks: [
    { id: 's1', description: 'first task' },
    { id: 's2', description: 'second task' },
  ],
};

describe('phase 1906: contract_created 创建通知工具名修正（M12）', () => {
  it('正文指示 submit_subtask，不再出现 done 工具指示', () => {
    const body = contractCreatedNotificationBody(FULL_INPUT);
    expect(body).toContain('submit_subtask');
    // 不得残留 subagent 专用 done 工具指示（行首工具名 / 示例调用两种形态）
    expect(body).not.toMatch(/via done\b/);
    expect(body).not.toMatch(/(^|\n)done:/);
  });

  it('示例参数键与真实 submit_subtask 工具 schema required 键一致', () => {
    const body = contractCreatedNotificationBody(FULL_INPUT);
    // sanity：真实 schema 的 required 键即工具名修正所依据的事实
    expect(SUBMIT_SUBTASK_SCHEMA.required).toEqual(['subtask', 'evidence']);
    // 取示例调用行（行首工具名 + 参数对象），而非指示句行
    const exampleLine = body.split('\n').find(l => l.startsWith('submit_subtask:'));
    expect(exampleLine).toBeDefined();
    for (const key of SUBMIT_SUBTASK_SCHEMA.required) {
      expect(exampleLine).toContain(`"${key}"`);
    }
    // 示例不虚构 schema 之外的必填键：示例键集合 ⊆ schema properties
    const exampleKeys = [...exampleLine!.matchAll(/"(\w+)":/g)].map(m => m[1]);
    for (const key of exampleKeys) {
      expect(Object.keys(SUBMIT_SUBTASK_SCHEMA.properties)).toContain(key);
    }
  });

  it('子任务列表逐条呈现（id + description），缺省字段省略不补造', () => {
    const body = contractCreatedNotificationBody(FULL_INPUT);
    expect(body).toContain('- s1: first task');
    expect(body).toContain('- s2: second task');
    expect(body).toContain('Background: B');
    expect(body).toContain('Expectations: E');

    const minimal = contractCreatedNotificationBody({
      contractId: 'c-002',
      title: 'T2',
      goal: 'G2',
      subtasks: [{ id: 's1', description: 'only task' }],
    });
    expect(minimal).not.toContain('Background:');
    expect(minimal).not.toContain('Expectations:');
    expect(minimal).toContain('Goal: G2');
    expect(minimal).toContain('- s1: only task');
  });
});
