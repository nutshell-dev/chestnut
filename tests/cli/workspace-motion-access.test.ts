import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

describe('workspace CLI caller access', () => {
  it.each([
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
  ])('rejects %j before workspace or credential effects', async (...args) => {
    const root = await createTrackedTempDir('workspace-access-');
    try {
      const result = spawnSync(process.execPath, [path.resolve('dist/cli.js'), ...args], {
        cwd: root,
        env: {
          ...process.env, CHESTNUT_ROOT: root, CHESTNUT_HOME: path.join(root, 'credentials'),
          CHESTNUT_CALLER_AGENT_ID: 'alice',
        },
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
