import { describe, it, expect } from 'vitest';
import { buildSubagentSystemPrompt } from '../../../src/templates/prompts/subagent.js';

describe('buildSubagentSystemPrompt', () => {
  it('教默认 clawspace + 推荐临时区 (phase 518)', () => {
    const result = buildSubagentSystemPrompt({
      taskId: 'abc123',
      callerClawId: 'main-claw',
      subagentsDir: 'tasks/subagents',
    });
    expect(result).toContain('Your default cwd is the clawspace of your caller "main-claw"');
    expect(result).toContain('Your dedicated temp dir: `../tasks/subagents/abc123/`');
    expect(result).toContain('recommended for working files');
  });

  it('mentions tool defaults and cross-claw access', () => {
    const result = buildSubagentSystemPrompt({
      taskId: 'x',
      callerClawId: 'caller',
      subagentsDir: 'tasks/subagents',
    });
    expect(result).toContain('exec / read / write / search / ls');
    expect(result).toContain('默认在 clawspace 目录');
    expect(result).toContain('访问其他 claw 用 read tools 的');
  });
});
