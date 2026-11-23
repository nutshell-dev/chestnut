const CLI_ACCESS_PROCESS_TIMEOUT_MS = 10_000;
const LAUNCHER_ACCESS_TEST_TIMEOUT_MS = 15_000;
const LAUNCHER_ACCESS_HOOK_TIMEOUT_MS = 10_000;

import { afterAll, describe, it, expect, vi } from 'vitest';
import { runChildProcess, withCleanupPreservingError } from '../utils/child-process.js';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

// This file is isolate:true; restore the pre-2215 fast-project budgets only here.
vi.setConfig({
  testTimeout: LAUNCHER_ACCESS_TEST_TIMEOUT_MS,
  hookTimeout: LAUNCHER_ACCESS_HOOK_TIMEOUT_MS,
});
afterAll(() => { vi.resetConfig(); });

describe('Launcher CLI caller access', () => {
  it.for(['setup', 'status', 'start', 'send', 'stream'])(
    'rejects %s before reading stdin or accessing the workspace', async (verb, context) => {
    const root = await createTrackedTempDir('launcher-access-');
    const operation = withCleanupPreservingError(async () => {
      const result = await runChildProcess(process.execPath, [path.resolve('dist/cli.js'), 'launcher', verb, '--json'], {
        cwd: root,
        env: { ...process.env, CHESTNUT_ROOT: root, CHESTNUT_CALLER_AGENT_ID: 'alice' },
        input: '{}\n', timeoutMs: CLI_ACCESS_PROCESS_TIMEOUT_MS, signal: context.signal,
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
    context.onTestFinished(() => operation);
    await operation;
  });
});
