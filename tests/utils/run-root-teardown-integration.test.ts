const RUN_ROOT_TEARDOWN_PROCESS_TIMEOUT_MS = 120_000;
const RECLAIM_STALE_FIXTURE_AGE_MS = 11 * 60 * 1000;
const FOLLOWUP_VITEST_RUN_COUNT = 2;

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHostTmpDir } from './run-root.js';
import { beginRetentionScope } from './resource-retention.js';

function createSandbox(): string {
  // 优先放在当前 invocation 的 run root 下，使异常中断时能被 teardown/reclaim 回收
  const runRoot = process.env.CHESTNUT_RUN_ROOT || getHostTmpDir();
  const sandbox = path.join(runRoot, `chestnut-integration-sandbox-${randomUUID()}`);
  fs.mkdirSync(sandbox, { recursive: true });
  return sandbox;
}

function createHistoricalRunRoot(
  sandbox: string,
  name: string,
  pid: number,
  withMarker: boolean,
): { root: string; markerPath: string; fixturePath: string } {
  const root = path.join(sandbox, `chestnut-run-${name}`);
  fs.mkdirSync(root);
  const markerPath = path.join(root, 'test-resource-failures.jsonl');
  const fixturePath = path.join(root, 'fixture.bin');
  fs.writeFileSync(fixturePath, Buffer.from([0, 1, 127, 128, 255]));
  if (withMarker) fs.writeFileSync(markerPath, '{"type":"unconfirmed-direct-child"}\n');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    invocationId: name,
    pid,
    worktree: path.join(sandbox, `removed-worktree-${name}`),
    startedAt: new Date().toISOString(),
    runRoot: root,
  }, null, 2));
  const stale = new Date(Date.now() - RECLAIM_STALE_FIXTURE_AGE_MS);
  fs.utimesSync(root, stale, stale);
  return { root, markerPath, fixturePath };
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
      CHESTNUT_HOST_TMPDIR: undefined,
      CHESTNUT_KEEP_TEST_TMP: keep ? '1' : undefined,
    },
    timeout: RUN_ROOT_TEARDOWN_PROCESS_TIMEOUT_MS,
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

  it('subsequent runs preserve marked history but reclaim an unmarked stale root', () => {
    const sandbox = createSandbox();
    const exitedOwner = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    expect(exitedOwner.status).toBe(0);
    const marked = createHistoricalRunRoot(sandbox, 'marked-history', exitedOwner.pid, true);
    const unmarked = createHistoricalRunRoot(sandbox, 'unmarked-history', exitedOwner.pid, false);
    const completed = createHistoricalRunRoot(sandbox, 'completed-history', exitedOwner.pid, false);
    beginRetentionScope({
      runRoot: completed.root,
      protectedPaths: [completed.fixturePath],
      label: 'completed integration history',
    }).complete();
    const staleCompleted = new Date(Date.now() - RECLAIM_STALE_FIXTURE_AGE_MS);
    fs.utimesSync(completed.root, staleCompleted, staleCompleted);
    const markerBytes = fs.readFileSync(marked.markerPath);
    const fixtureBytes = fs.readFileSync(marked.fixturePath);
    try {
      for (let run = 0; run < FOLLOWUP_VITEST_RUN_COUNT; run += 1) {
        const result = runVitestInSandbox(sandbox, false);
        expect(result.status).toBe(0,
          `Follow-up Vitest ${run + 1} failed:\n${result.stdout}\n${result.stderr}`);
        expect(result.stderr).toContain(`preserving resource-failure run root: ${marked.root}`);
        expect(fs.existsSync(marked.root)).toBe(true);
        expect(fs.readFileSync(marked.markerPath)).toEqual(markerBytes);
        expect(fs.readFileSync(marked.fixturePath)).toEqual(fixtureBytes);
        expect(fs.existsSync(unmarked.root)).toBe(false);
        expect(fs.existsSync(completed.root)).toBe(false);
      }
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
