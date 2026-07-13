import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHostTmpDir } from './run-root.js';

function createSandbox(): string {
  const sandbox = path.join(getHostTmpDir(), `chestnut-integration-sandbox-${randomUUID()}`);
  fs.mkdirSync(sandbox, { recursive: true });
  return sandbox;
}

function runVitestInSandbox(
  sandbox: string,
  keep: boolean,
): ReturnType<typeof spawnSync> {
  const testFile = path.join(__dirname, 'run-root.test.ts');
  return spawnSync('npx', ['vitest', 'run', testFile, '--no-color'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      TMPDIR: sandbox,
      TMP: sandbox,
      TEMP: sandbox,
      CHESTNUT_RUN_ROOT: undefined,
      CHESTNUT_INVOCATION_ID: undefined,
      CHESTNUT_KEEP_TEST_TMP: keep ? '1' : undefined,
    },
    timeout: 120000,
    encoding: 'utf-8',
  });
}

describe('run-root teardown integration', () => {
  it('spawn vitest → run root created → vitest exits → run root cleaned up', () => {
    const sandbox = createSandbox();
    try {
      const result = runVitestInSandbox(sandbox, false);
      expect(result.status).toBe(0,
        `Child vitest failed:\n${result.stdout}\n${result.stderr}`);

      const dirs = fs.readdirSync(sandbox)
        .filter(d => d.startsWith('chestnut-run-'));
      expect(dirs).toHaveLength(0,
        `Teardown failed: run root(s) left behind in sandbox: ${dirs.join(', ')}\nspawn output:\n${result.stdout}\n${result.stderr}`);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('CHESTNUT_KEEP_TEST_TMP=1 preserves run root', () => {
    const sandbox = createSandbox();
    try {
      const result = runVitestInSandbox(sandbox, true);
      expect(result.status).toBe(0,
        `Child vitest failed:\n${result.stdout}\n${result.stderr}`);

      const dirs = fs.readdirSync(sandbox)
        .filter(d => d.startsWith('chestnut-run-'));
      expect(dirs.length).toBeGreaterThan(0,
        `Expected run root to be preserved with CHESTNUT_KEEP_TEST_TMP=1\nspawn output:\n${result.stdout}\n${result.stderr}`);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
