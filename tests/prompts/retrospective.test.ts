import { describe, it, expect } from 'vitest';
import { buildRetroPrompt } from '../../src/prompts/retrospective.js';

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
});
