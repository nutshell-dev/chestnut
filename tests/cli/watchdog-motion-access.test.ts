import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

describe('Watchdog CLI caller access', () => {
  it.each(['start', 'stop'])(
    'rejects %s before reading stdin or accessing the workspace', async (verb) => {
    const root = await createTrackedTempDir('watchdog-access-');
    try {
      const result = spawnSync(process.execPath, [path.resolve('dist/cli.js'), 'watchdog', verb], {
        cwd: root,
        env: { ...process.env, CHESTNUT_ROOT: root, CHESTNUT_CALLER_AGENT_ID: 'alice' },
        input: '{}\n', encoding: 'utf8', timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('agent-initiated CLI calls (caller=alice) are not allowed');
      expect(result.stdout).toBe('');
      expect(await readdir(root)).toEqual([]);
    } finally {
      await cleanupTempDir(root);
    }
  });
});
