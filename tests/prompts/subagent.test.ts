import { describe, it, expect } from 'vitest';
import { buildSubagentSystemPromptPrefix } from '../../src/prompts/subagent.js';

describe('buildSubagentSystemPromptPrefix', () => {
  it('教默认 clawspace + 推荐临时区 (phase 518)', () => {
    const result = buildSubagentSystemPromptPrefix({
      taskId: 'abc123',
      callerClawId: 'main-claw',
    });
    expect(result).toContain('Your default workspace: `clawspace/`');
    expect(result).toContain('shared with your caller "main-claw"');
    expect(result).toContain('Your dedicated temp dir: `tasks/subagents/abc123/`');
    expect(result).toContain('recommended for ephemeral files');
  });

  it('mentions tool defaults and cross-claw access', () => {
    const result = buildSubagentSystemPromptPrefix({
      taskId: 'x',
      callerClawId: 'caller',
    });
    expect(result).toContain('exec / read / write / search / ls');
    expect(result).toContain('默认在 `clawspace/`');
    expect(result).toContain('访问其他 claw 用 read tools 的');
  });
});
