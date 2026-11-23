const CLI_ACCESS_PROCESS_TIMEOUT_MS = 10_000;

import { describe, it, expect } from 'vitest';
import {
  ChildProcessLifecycleError,
  runChildProcess,
  withCleanupPreservingError,
  type ChildProcessFailureDetails,
} from '../utils/child-process.js';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

async function startWorkspaceAccess(
  args: string[],
  signal: AbortSignal,
  execute: typeof runChildProcess = runChildProcess,
): Promise<{ root: string; operation: Promise<void> }> {
  const root = await createTrackedTempDir('workspace-access-');
  const operation = withCleanupPreservingError(async () => {
    const result = await execute(process.execPath, [path.resolve('dist/cli.js'), ...args], {
      cwd: root,
      env: {
        ...process.env, CHESTNUT_ROOT: root,
        CHESTNUT_CALLER_AGENT_ID: 'alice',
      },
      input: '{}\n', timeoutMs: CLI_ACCESS_PROCESS_TIMEOUT_MS, signal,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('motion access denied: caller=agent');
    expect(result.stderr).not.toContain('caller=alice');
    expect(result.stdout).toBe('');
    expect(await readdir(path.join(root, '.chestnut'))).toEqual(['audit.tsv']);
    const audit = await readFile(path.join(root, '.chestnut', 'audit.tsv'), 'utf8');
    expect(audit).toContain('cli_motion_access_denied');
    expect(audit).toContain('caller=agent');
  }, () => cleanupTempDir(root));
  return { root, operation };
}

function unconfirmedFailure(): ChildProcessLifecycleError {
  return new ChildProcessLifecycleError({
    command: process.execPath,
    args: [],
    pid: 123,
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    errors: [],
    directChild: { state: 'unconfirmed' },
    stdio: 'detached',
    outputTruncated: true,
    outputTruncatedAt: null,
    reason: 'timeout',
    timeoutMs: CLI_ACCESS_PROCESS_TIMEOUT_MS,
    killGraceMs: 0,
    exitConfirmMs: 0,
    killSignals: [],
    killAttempts: [],
    killErrors: [],
    cleanup: 'detached',
    resourceEvidence: { state: 'not_configured' },
  } as ChildProcessFailureDetails, new Error('injected unconfirmed child'));
}

describe('workspace CLI caller access', () => {
  it.for([
    ['init'],
    ['dispatch-skill', 'list'],
    ['dispatch-skill', 'history', 'sample'],
    ['dispatch-skill', 'edit', 'begin', 'sample', '--reason', 'test'],
    ['dispatch-skill', 'edit', 'submit', 'sample'],
    ['dispatch-skill', 'edit', 'basis', 'sample', '--actor', 'alice', '--reason', 'test'],
    ['dispatch-skill', 'edit', 'retry', 'sample'],
    ['dispatch-skill', 'edit', 'status', 'sample'],
    ['config', 'provider', 'add'],
    ['config', 'provider', 'remove', 'sample'],
    ['config', 'provider', 'set-primary', 'sample'],
    ['config', 'provider', 'move', 'sample', '1'],
    ['config', 'provider', 'login', 'sample'],
    ['config', 'provider', 'logout', 'sample'],
  ])('rejects %j before workspace or credential effects', async (args, context) => {
    const { operation } = await startWorkspaceAccess(args, context.signal);
    context.onTestFinished(() => operation);
    await operation;
  });

  it('preserves the real caller fixture when its child exit is unconfirmed', async () => {
    const failure = unconfirmedFailure();
    const { root, operation } = await startWorkspaceAccess(
      ['init'],
      new AbortController().signal,
      async () => { throw failure; },
    );
    const observed = await operation.then(() => undefined, (error: unknown) => error);
    expect(observed).toBe(failure);
    expect(existsSync(root)).toBe(true);
    await cleanupTempDir(root);
  });
});
