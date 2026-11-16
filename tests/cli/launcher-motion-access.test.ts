const CLI_ACCESS_PROCESS_TIMEOUT_MS = 10_000;

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

describe('Launcher CLI caller access', () => {
  it.each(['setup', 'status', 'start', 'send', 'stream'])(
    'rejects %s before reading stdin or accessing the workspace', async (verb) => {
    const root = await createTrackedTempDir('launcher-access-');
    try {
      const result = spawnSync(process.execPath, [path.resolve('dist/cli.js'), 'launcher', verb, '--json'], {
        cwd: root,
        env: { ...process.env, CHESTNUT_ROOT: root, CHESTNUT_CALLER_AGENT_ID: 'alice' },
        input: '{}\n', encoding: 'utf8', timeout: CLI_ACCESS_PROCESS_TIMEOUT_MS,
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
    } finally {
      await cleanupTempDir(root);
    }
  });
});
