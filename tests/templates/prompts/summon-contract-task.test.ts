import { describe, it, expect } from 'vitest';
import { buildSummonContractTask } from '../../../src/templates/prompts/summon-contract-task.js';

describe('buildSummonContractTask (Phase 1396 Step K)', () => {
  it('produces the single active prompt shape', () => {
    const text = buildSummonContractTask('goal', 'skills summary');

    expect(text).toContain('## 本次目标');
    expect(text).toContain('goal');
    expect(text).toContain('skills summary');
    expect(text).toContain('chestnut contract create --claw <targetClawId>');
    expect(text).toContain('background');
    expect(text).toContain('expectations');
    expect(text).toContain('subtasks');
  });

  it('omits verification/escalation scaffolding (no-verification is fixed policy)', () => {
    const text = buildSummonContractTask('goal');

    expect(text).not.toContain('verification/');
    expect(text).not.toContain('prompt_file');
    expect(text).not.toContain('{{evidence}}');
    expect(text).not.toContain('subtask_id:');
    expect(text).not.toContain('type: llm');
    expect(text).not.toContain('escalation:');
  });

  it('still teaches internal executor selection and contract create CLI', () => {
    const text = buildSummonContractTask('goal');

    expect(text).toContain('chestnut claw list --summary');
    expect(text).toContain('chestnut contract create --claw <targetClawId>');
    expect(text).toContain('./contract-drafts/<contract-slug>/');
  });

  it('does not present no-verification as a caller choice', () => {
    const text = buildSummonContractTask('goal');

    for (const banned of ['用户指定', 'SummonDecision.targetClaw', 'verify:true', '调用方.*verify', 'target_claw 已由用户指定']) {
      expect(text).not.toMatch(new RegExp(banned));
    }
    expect(text).toContain('这是 SummonSystem 当前固定创建策略');
  });

  it('rejects cross-claw patching boundary without legacy targetClaw gate wording', () => {
    const text = buildSummonContractTask('goal');

    expect(text).not.toContain('SUMMON_TARGET_CLAW_VIOLATION');
    expect(text).toContain('只能');
    expect(text).toContain('不补缺');
  });

  it('teaches a complete done() example and ends at contract creation (Phase 1396 Step M)', () => {
    const text = buildSummonContractTask('goal');

    // 完整括号示例（修复缺右括号的破损示例）
    expect(text).toContain('done(result="<给 Motion 的简报>")');
    expect(text).not.toMatch(/done\(result="<给 Motion 的简报>"\s*`/);
    // 创建成功即任务结束；不再出现“系统自动登记 retro”旧叙事
    expect(text).toContain('创建成功即任务结束');
    expect(text).not.toContain('自动登记 retro');
    expect(text).not.toContain('retro');
  });
});
