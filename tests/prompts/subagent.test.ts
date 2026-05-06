import { describe, it, expect } from 'vitest';
import { buildSubagentWorkspaceContext, buildSubagentSystemPromptPrefix } from '../../src/prompts/subagent.js';

describe('buildSubagentWorkspaceContext', () => {
  it('includes own workspace and caller workspace', () => {
    const result = buildSubagentWorkspaceContext({
      ownWorkspaceRel: 'tasks/subagents/abc123',
      callerClawspaceRel: 'clawspace',
    });
    expect(result).toContain('tasks/subagents/abc123');
    expect(result).toContain('clawspace');
    expect(result).toContain('Your workspace');
    expect(result).toContain("Caller's workspace");
  });

  it('mentions tool defaults', () => {
    const result = buildSubagentWorkspaceContext({
      ownWorkspaceRel: 'tasks/subagents/x',
      callerClawspaceRel: 'clawspace',
    });
    expect(result).toContain('exec / read / write / search / ls');
    expect(result).toContain('默认在 your workspace');
  });
});

describe('buildSubagentSystemPromptPrefix', () => {
  it('includes taskId workspace and caller clawId', () => {
    const result = buildSubagentSystemPromptPrefix({
      taskId: 'abc123',
      callerClawId: 'main-claw',
    });
    expect(result).toContain('tasks/subagents/abc123/');
    expect(result).toContain('claw "main-claw"');
    expect(result).toContain('claw: "main-claw"');
  });

  it('mentions tool defaults and cross-claw access', () => {
    const result = buildSubagentSystemPromptPrefix({
      taskId: 'x',
      callerClawId: 'caller',
    });
    expect(result).toContain('exec / read / write / search / ls');
    expect(result).toContain('默认在 your workspace');
    expect(result).toContain('访问 caller 的资源用');
  });
});
