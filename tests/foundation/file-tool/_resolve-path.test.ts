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

  it('cwd: ".." escapes workspace to claw root (workspace-relative / phase 519)', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'MEMORY.md', '..')).toBe('MEMORY.md');
  });

  it('cwd: "../memory" resolves to claw root memory (phase 519)', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'x.md', '../memory')).toBe('memory/x.md');
  });

  it('cwd: "subdir" stays in workspace (workspace-relative / phase 519)', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'foo.txt', 'subdir')).toBe('clawspace/subdir/foo.txt');
  });

  it('cwd: "../tasks/subagents/<id>" resolves subagent temp dir (phase 519)', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'foo.md', '../tasks/subagents/abc')).toBe('tasks/subagents/abc/foo.md');
  });

  it('absolute cwd passes through (phase 519)', () => {
    const ctx = mockCtx({ clawDir: '/c', workspaceDir: '/c/clawspace' });
    expect(resolveWorkspacePath(ctx, 'foo.txt', '/abs/path')).toBe('../abs/path/foo.txt');
  });

  it('subagent default base = clawspace (phase 518)', () => {
    const ctx = mockCtx({
      clawDir: '/c',
      workspaceDir: '/c/clawspace',  // phase 518: subagent default workspaceDir = clawspace
    });
    expect(resolveWorkspacePath(ctx, 'foo.txt')).toBe('clawspace/foo.txt');
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
