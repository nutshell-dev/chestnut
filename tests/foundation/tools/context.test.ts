import { describe, it, expect } from 'vitest';
import path from 'path';
import { ExecContextImpl, cloneExecContext } from '../../../src/foundation/tools/context.js';

describe('ExecContextImpl', () => {
  it('ctor 默认 workspaceDir = clawDir/clawspace', () => {
    const ctx = new ExecContextImpl({
      clawId: 'test',
      clawDir: '/tmp/test-claw',
      syncDir: '/tmp/test-claw/tasks/sync',
      profile: 'full',
      fs: {} as any,
    });
    expect(ctx.workspaceDir).toBe('/tmp/test-claw/clawspace');
  });

  it('ctor 显式 workspaceDir 覆盖 default', () => {
    const ctx = new ExecContextImpl({
      clawId: 'test',
      clawDir: '/tmp/test-claw',
      workspaceDir: '/tmp/test-claw/tasks/subagents/abc',
      syncDir: '/tmp/test-claw/tasks/sync',
      profile: 'subagent',
      fs: {} as any,
    });
    expect(ctx.workspaceDir).toBe('/tmp/test-claw/tasks/subagents/abc');
  });

  it('cloneExecContext 继承 workspaceDir', () => {
    const parent = new ExecContextImpl({
      clawId: 'p',
      clawDir: '/p',
      workspaceDir: '/p/clawspace',
      syncDir: '/p/tasks/sync',
      profile: 'claw',
      fs: {} as any,
    });
    const cloned = cloneExecContext(parent, { profile: 'subagent' });
    expect(cloned.workspaceDir).toBe('/p/clawspace');
    expect(cloned.profile).toBe('subagent');
  });
});
