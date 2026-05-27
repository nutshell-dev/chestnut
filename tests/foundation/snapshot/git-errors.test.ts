/**
 * Git error classifier tests
 */

import { describe, it, expect } from 'vitest';
import { classifyGitError } from '../../../src/foundation/snapshot/git-errors.js';

describe('classifyGitError', () => {
  // ─── Expected failures (白名单) ───────────────────────────────────────────

  it('classifies "not a git repository" as not_a_repo', () => {
    const result = classifyGitError({
      message: 'fatal: not a git repository',
      output: 'fatal: not a git repository (or any of the parent directories): .git',
      exitCode: 128,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('not_a_repo');
    }
  });

  it('classifies "nothing to commit" as nothing_to_commit', () => {
    const result = classifyGitError({
      message: 'nothing to commit',
      output: 'On branch main\nnothing to commit, working tree clean',
      exitCode: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('nothing_to_commit');
    }
  });

  it('classifies "no commits yet" as no_commits_yet', () => {
    const result = classifyGitError({
      message: 'does not have any commits yet',
      output: 'fatal: your current branch "main" does not have any commits yet',
      exitCode: 128,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('no_commits_yet');
    }
  });

  it('classifies "could not get a repository handle" as no_repo_handle', () => {
    const result = classifyGitError({
      message: 'could not get a repository handle',
      output: 'could not get a repository handle for current working directory',
      exitCode: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('no_repo_handle');
    }
  });

  it('classifies exit non-0 with no match as uncategorized', () => {
    const result = classifyGitError({
      message: 'some random git error',
      output: 'random unknown error',
      exitCode: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('uncategorized');
      expect(result.value.exitCode).toBe(2);
    }
  });

  // ─── Unexpected failures (errno 白名单) ───────────────────────────────────

  it('throws on ENOENT', () => {
    expect(() => classifyGitError({
      message: 'ENOENT: git not found',
      code: 'ENOENT',
    })).toThrow();
  });

  it('throws on EACCES', () => {
    expect(() => classifyGitError({
      message: 'EACCES: permission denied',
      code: 'EACCES',
    })).toThrow();
  });

  it('throws on EPERM', () => {
    expect(() => classifyGitError({
      message: 'EPERM: operation not permitted',
      code: 'EPERM',
    })).toThrow();
  });

  it('throws on ENOSPC', () => {
    expect(() => classifyGitError({
      message: 'ENOSPC: no space left on device',
      code: 'ENOSPC',
    })).toThrow();
  });

  it('throws on EIO', () => {
    expect(() => classifyGitError({
      message: 'EIO: i/o error',
      code: 'EIO',
    })).toThrow();
  });

  // ─── Signal termination ───────────────────────────────────────────────────

  it('throws on signal termination', () => {
    expect(() => classifyGitError({
      message: 'SIGTERM',
      signal: 'SIGTERM',
    })).toThrow();
  });

  it('classifies exit code >= 128 without match as uncategorized (no signal)', () => {
    const result = classifyGitError({
      message: 'exit 130',
      exitCode: 130,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('uncategorized');
      expect(result.value.exitCode).toBe(130);
    }
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it('throws when exitCode missing and stderr empty', () => {
    expect(() => classifyGitError({
      message: 'unknown',
    })).toThrow();
  });
});
