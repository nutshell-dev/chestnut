import { describe, it, expect } from 'vitest';
import { buildSummonContractTask } from '../../../src/templates/prompts/summon-contract-task.js';

describe('buildSummonContractTask', () => {
  it('verify=false omits all verification scaffolding', () => {
    const text = buildSummonContractTask('goal', '', 'claw', { verify: false });
    expect(text).not.toContain('verification/');
    expect(text).not.toContain('prompt_file');
    expect(text).not.toContain('{{evidence}}');
    expect(text).not.toContain('subtask_id:');
    expect(text).not.toContain('type: llm');
    expect(text).toContain('verify=false');                 // 仍含明示
    expect(text).toContain('禁止在 contract.yaml 写');      // 仍含禁令
    // verification: 仅在禁令行出现（不出现 yaml 模板或 verification/.prompt.txt 格式段）
    const verificationMatches = text.match(/verification:/g);
    expect(verificationMatches?.length ?? 0).toBe(1);
  });

  it('verify=true preserves full verification scaffolding', () => {
    const text = buildSummonContractTask('goal', '', 'claw', { verify: true });
    expect(text).toContain('verification/');
    expect(text).toContain('verification:');
    expect(text).toContain('prompt_file');
    expect(text).toContain('{{evidence}}');
    expect(text).toContain('subtask_id:');
    expect(text).toContain('type: llm');
  });

  it('verify default is false (no flag = no verification scaffolding)', () => {
    const text = buildSummonContractTask('goal', '', 'claw');
    expect(text).not.toContain('verification/');
    expect(text).not.toContain('subtask_id:');
  });

  it('phase 119: omits two-phase scaffolding (verify=false)', () => {
    const text = buildSummonContractTask('goal', '', 'claw', { verify: false });
    expect(text).not.toContain('第一阶段');
    expect(text).not.toContain('第二阶段');
    expect(text).not.toContain('字段来自第一阶段推理');
  });

  it('phase 119: omits two-phase scaffolding (verify=true)', () => {
    const text = buildSummonContractTask('goal', '', 'claw', { verify: true });
    expect(text).not.toContain('第一阶段');
    expect(text).not.toContain('第二阶段');
    expect(text).not.toContain('字段来自第一阶段推理');
  });

  it('phase 119: target_claw boundary hard constraint present', () => {
    const text = buildSummonContractTask('goal', '', 'my-claw', { verify: false });
    expect(text).toContain('SUMMON_TARGET_CLAW_VIOLATION');
    expect(text).toContain('只能');
    expect(text).toContain('不补');
    expect(text).toContain('target_claw');
  });

  it('phase 119: yaml field names preserved despite phase 1 deletion', () => {
    for (const verify of [false, true]) {
      const text = buildSummonContractTask('goal', '', 'claw', { verify });
      expect(text).toContain('background');
      expect(text).toContain('expectations');
      expect(text).toContain('subtasks');
    }
  });
});
