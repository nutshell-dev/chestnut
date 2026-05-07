import { describe, it, expect } from 'vitest';
import { resolveWorkspacePath } from '../../../src/foundation/file-tool/_resolve-path.js';

function mockCtx(opts: { clawDir: string; workspaceDir: string }) {
  return {
    clawDir: opts.clawDir,
    workspaceDir: opts.workspaceDir,
  } as any;
}

describe('resolveWorkspacePath', () => {
  it('default base = workspaceDir', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'foo.txt')).toBe('clawspace/foo.txt');
  });

  it('cwd: ".." resolves to claw root', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'MEMORY.md', '..')).toBe('MEMORY.md');
  });

  it('cwd: "memory" resolves to memory subdir (relative to clawDir / phase 518 align)', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'x.md', 'memory')).toBe('memory/x.md');
  });

  it('subagent cwd: "tasks/subagents/abc" resolves to temp dir (phase 518)', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'temp.txt', 'tasks/subagents/abc')).toBe('tasks/subagents/abc/temp.txt');
  });

  it('subagent default base = subagents/<id>', () => {
    const ctx = mockCtx({
      clawDir: '/c',
      workspaceDir: '/c/tasks/subagents/abc',
    });
    expect(resolveWorkspacePath(ctx, 'foo.txt')).toBe('tasks/subagents/abc/foo.txt');
  });

  it('absolute path passes through', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    // /abs/path.txt relative to /c = ../abs/path.txt
    expect(resolveWorkspacePath(ctx, '/abs/path.txt')).toBe('../abs/path.txt');
  });

  it('path traversal escapes clawDir', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, '../../etc/passwd')).toBe('../etc/passwd');
    // Note: actual escape check (startsWith('..')) is done by caller
  });
});
