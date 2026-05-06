import { describe, it, expect } from 'vitest';
import { buildSubagentWorkspaceContext } from '../../src/prompts/subagent.js';

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
