const CLI_ACCESS_PROCESS_TIMEOUT_MS = 10_000;
const WATCHDOG_ACCESS_TEST_TIMEOUT_MS = 15_000;
const WATCHDOG_ACCESS_HOOK_TIMEOUT_MS = 10_000;

import { afterAll, describe, it, expect, vi } from 'vitest';
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

// This file is isolate:true; restore the pre-2215 fast-project budgets only here.
vi.setConfig({
  testTimeout: WATCHDOG_ACCESS_TEST_TIMEOUT_MS,
  hookTimeout: WATCHDOG_ACCESS_HOOK_TIMEOUT_MS,
});
afterAll(() => { vi.resetConfig(); });

async function startWatchdogAccess(
  verb: string,
  signal: AbortSignal,
  execute: typeof runChildProcess = runChildProcess,
): Promise<{ root: string; operation: Promise<void> }> {
  const root = await createTrackedTempDir('watchdog-access-');
  const operation = withCleanupPreservingError(async () => {
    const result = await execute(process.execPath, [path.resolve('dist/cli.js'), 'watchdog', verb], {
      cwd: root,
      env: { ...process.env, CHESTNUT_ROOT: root, CHESTNUT_CALLER_AGENT_ID: 'alice' },
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

describe('Watchdog CLI caller access', () => {
  it.for(['start', 'stop'])(
    'rejects %s before reading stdin or accessing the workspace', async (verb, context) => {
    const { operation } = await startWatchdogAccess(verb, context.signal);
    context.onTestFinished(() => operation);
    await operation;
  });

  it('preserves the real caller fixture when its child exit is unconfirmed', async () => {
    const failure = unconfirmedFailure();
    const { root, operation } = await startWatchdogAccess(
      'start',
      new AbortController().signal,
      async () => { throw failure; },
    );
    const observed = await operation.then(() => undefined, (error: unknown) => error);
    expect(observed).toBe(failure);
    expect(existsSync(root)).toBe(true);
    await cleanupTempDir(root);
  });
});
