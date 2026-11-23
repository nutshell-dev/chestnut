import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRunRootTeardown,
} from '../../.config/vitest-global-setup.js';
import type { RunManifest } from '../../.config/vitest-global-setup.js';
import { getRunRoot, getRunSubDir, getHostTmpDir } from './run-root.js';
import { createTrackedTempDir, cleanupTempDir } from './temp.js';

describe('run-root utils', () => {
  it('getRunRoot returns CHESTNUT_RUN_ROOT env var', () => {
    const runRoot = getRunRoot();
    expect(runRoot).toBeDefined();
    expect(runRoot).toBe(process.env.CHESTNUT_RUN_ROOT);
  });

  it('getRunSubDir returns a child of run root', () => {
    const runRoot = getRunRoot();
    const subDir = getRunSubDir('claws');
    expect(subDir).toBeDefined();
    expect(subDir).toContain(runRoot!);
    expect(subDir).toContain('claws');
  });

  it('getHostTmpDir returns a real OS tmpdir path', () => {
    const hostTmp = getHostTmpDir();
    expect(hostTmp).toBeDefined();
    // 在 TMPDIR 被重定向的测试 invocation 中，getHostTmpDir 应不同于当前 os.tmpdir()
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    expect(hostTmp).not.toBe(os.tmpdir());
  });

  it('TMPDIR is redirected to run root', () => {
    const runRoot = getRunRoot();
    expect(process.env.TMPDIR).toBe(runRoot);
    expect(process.env.TMP).toBe(runRoot);
    expect(process.env.TEMP).toBe(runRoot);
  });

  it.each([false, true])(
    'fails and preserves a marked run root (KEEP_TEST_TMP=%s)',
    async keep => {
      const runRoot = await createTrackedTempDir('marked-run-root-');
      const originalKeep = process.env.CHESTNUT_KEEP_TEST_TMP;
      const manifest: RunManifest = {
        invocationId: 'unit-test-invocation',
        pid: process.pid,
        worktree: process.cwd(),
        startedAt: new Date().toISOString(),
        runRoot,
      };
      fs.writeFileSync(
        path.join(runRoot, 'test-resource-failures.jsonl'),
        `${JSON.stringify({ type: 'unconfirmed-direct-child', pid: 123 })}\n`,
      );
      try {
        if (keep) process.env.CHESTNUT_KEEP_TEST_TMP = '1';
        else delete process.env.CHESTNUT_KEEP_TEST_TMP;

        await expect(createRunRootTeardown(manifest)()).rejects.toThrow(
          /Unconfirmed child process resources.*preserving run root/,
        );
        expect(fs.existsSync(runRoot)).toBe(true);
        expect(fs.existsSync(path.join(runRoot, 'test-resource-failures.jsonl'))).toBe(true);
      } finally {
        if (originalKeep === undefined) delete process.env.CHESTNUT_KEEP_TEST_TMP;
        else process.env.CHESTNUT_KEEP_TEST_TMP = originalKeep;
        await cleanupTempDir(runRoot);
      }
    },
  );
});
