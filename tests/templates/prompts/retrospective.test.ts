import { describe, it, expect } from 'vitest';
import { buildRetroPrompt } from '../../../src/templates/prompts/retrospective.js';

describe('buildRetroPrompt', () => {
  const sampleYaml = `schema_version: 1
title: "分析日志"
background: "用户想了解最近的错误模式"
goal: "分析过去一周的错误日志"
expectations: |
  输出保存到 clawspace/log-analysis/
subtasks:
  - id: collect-logs
    description: "收集日志"`;

  it('should include contractYaml in output', () => {
    const result = buildRetroPrompt('my-claw', 'c-001', sampleYaml);
    expect(result).toContain(sampleYaml);
  });

  it('should include clawId and contractId', () => {
    const result = buildRetroPrompt('my-claw', 'c-001', sampleYaml);
    expect(result).toContain('my-claw');
    expect(result).toContain('c-001');
  });

  it('should include skillsSummary when provided', () => {
    const result = buildRetroPrompt('my-claw', 'c-001', sampleYaml, '## Skills\n- gen-report');
    expect(result).toContain('gen-report');
  });

  // Phase 1919 Step E：第四步改为分支编辑事务工作流
  it('Step 4 instructs branch edit workflow (begin/submit/retry), not direct dispatch writes', () => {
    const result = buildRetroPrompt('my-claw', 'c-001', sampleYaml, '## Skills\n- gen-report');
    expect(result).toContain('chestnut skill edit begin <skill-name> --reason');
    expect(result).toContain('chestnut skill edit submit <edit-id>');
    expect(result).toContain('chestnut skill edit retry <edit-id>');
    expect(result).toContain('chestnut skill history <skill-name>');
    expect(result).toContain('kind=conflict');
    expect(result).toContain('不得伪报技能已更新');
    // Phase 1923 Step C：依据缺失拒绝发布的补依据指引
    expect(result).toContain('kind=basis_required');
    expect(result).toContain('chestnut skill edit basis <edit-id>');
    // 旧共享写指令零命中（反向）
    expect(result).not.toContain('用 write 工具写入 dispatch-skill');
    expect(result).not.toContain('dispatch-skills/<skill-name>/');
  });

  it('Step 5 requires published version reference or explicit unpublished note', () => {
    const result = buildRetroPrompt('my-claw', 'c-001', sampleYaml);
    expect(result).toContain('published version');
    expect(result).toContain('未发布');
  });
});
