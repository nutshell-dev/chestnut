import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ChildProcessLifecycleError,
  runChildProcess,
  withCleanupPreservingError,
} from './child-process.js';
import {
  cleanupTempDir,
  createScopedTempDirSync,
  createTrackedTempDir,
  untrackTempDir,
} from './temp.js';
import type { RetentionScope } from './resource-retention.js';

const SAMPLE_TIMEOUT_MS = 25_000;
const EXTERNAL_CONSUMER_TIMEOUT_MS = 10_000;
const RECLAIM_STALE_AGE_MS = 11 * 60 * 1000;
function externalGlobalSetupModuleUrl(runRoot: string): string {
  const configDir = path.join(runRoot, '.config');
  const utilsDir = path.join(runRoot, 'tests/utils');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(utilsDir, { recursive: true });
  const globalSetup = fs.readFileSync(
    path.resolve(__dirname, '../../.config/vitest-global-setup.ts'), 'utf8',
  ).replace('../tests/utils/resource-retention.js', '../tests/utils/resource-retention.ts');
  fs.writeFileSync(path.join(configDir, 'vitest-global-setup.ts'), globalSetup);
  fs.copyFileSync(
    path.resolve(__dirname, 'resource-retention.ts'),
    path.join(utilsDir, 'resource-retention.ts'),
  );
  return pathToFileURL(path.join(configDir, 'vitest-global-setup.ts')).href;
}

interface WorkerConfiguration {
  maxWorkers: number;
  pool: string;
  groupOrder: number;
}

interface EffectiveProject {
  projectName: string;
  workerConfiguration: WorkerConfiguration;
}

interface RawPayload {
  schemaVersion: number;
  run: {
    projectName: string;
    workerConfiguration: WorkerConfiguration;
  };
}

interface CombinedRun {
  schemaVersion: number;
  projects: EffectiveProject[];
}

interface SampleManifest {
  schemaVersion: number;
  failed: boolean;
  samplingMode: string;
  effectiveProjects: EffectiveProject[];
  options: { workers: number };
}

interface SampleSummary {
  schemaVersion: number;
  comparableFields: {
    workers: number;
    samplingMode: string;
    effectiveProjects: EffectiveProject[];
  };
}

interface SampleCase {
  project: 'fast' | 'resource';
  filter: string;
  requestedWorkers: number;
  actualWorkers: number;
  groupOrder: number;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function createSampleRepository(repoRoot: string): {
  sampleRoot: string;
  hostTmpDir: string;
  retention: RetentionScope;
} {
  const { dir: sampleRoot, retention } = createScopedTempDirSync('test-cost-workers-');
  for (const entry of ['.config', 'scripts', 'tests', 'src', 'dist', 'node_modules']) {
    fs.symlinkSync(path.join(repoRoot, entry), path.join(sampleRoot, entry), 'dir');
  }
  for (const entry of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']) {
    fs.symlinkSync(path.join(repoRoot, entry), path.join(sampleRoot, entry), 'file');
  }
  const hostTmpDir = path.join(sampleRoot, 'nested-host-tmp');
  fs.mkdirSync(hostTmpDir);
  return { sampleRoot, hostTmpDir, retention };
}

async function runSample(
  sample: SampleCase,
  signal: AbortSignal,
  sampleRoot: string,
  hostTmpDir: string,
  execute: typeof runChildProcess,
): Promise<string> {
  const repoRoot = path.resolve(__dirname, '../..');
  const result = await execute(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/test-cost-baseline.mjs'),
      '--workers', String(sample.requestedWorkers),
      '--warmup', '0',
      '--runs', '1',
      '--project', sample.project,
      sample.filter,
    ],
    {
      cwd: sampleRoot,
      env: {
        ...process.env,
        VITEST_MAX_WORKERS: '64',
        VITEST_MAX_THREADS: sample.project === 'resource' ? '1' : undefined,
        CHESTNUT_RUN_ROOT: undefined,
        CHESTNUT_INVOCATION_ID: undefined,
        CHESTNUT_HOST_TMPDIR: hostTmpDir,
        CHESTNUT_KEEP_TEST_TMP: undefined,
        TMPDIR: hostTmpDir,
        TMP: hostTmpDir,
        TEMP: hostTmpDir,
      },
      timeoutMs: SAMPLE_TIMEOUT_MS,
      signal,
    },
  );
  expect(result.status, `cost sample failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  const runDir = result.stdout.trim();
  expect(path.isAbsolute(runDir)).toBe(true);
  expect(runDir.startsWith(`${fs.realpathSync(sampleRoot)}${path.sep}`)).toBe(true);
  return runDir;
}

function expectWorkerFacts(runDir: string, sample: SampleCase): void {
  const expectedConfiguration: WorkerConfiguration = {
    maxWorkers: sample.actualWorkers,
    pool: 'threads',
    groupOrder: sample.groupOrder,
  };
  const expectedProjects: EffectiveProject[] = [{
    projectName: sample.project,
    workerConfiguration: expectedConfiguration,
  }];
  const raw = readJson<RawPayload>(
    path.join(runDir, 'raw', `run-1-${sample.project}.json`),
  );
  const combined = readJson<CombinedRun>(path.join(runDir, 'runs', 'run-1.json'));
  const manifest = readJson<SampleManifest>(path.join(runDir, 'manifest.json'));
  const summary = readJson<SampleSummary>(path.join(runDir, 'summary.json'));

  expect(raw.schemaVersion).toBe(5);
  expect(raw.run.projectName).toBe(sample.project);
  expect(raw.run.workerConfiguration).toEqual(expectedConfiguration);
  expect(combined.schemaVersion).toBe(5);
  expect(combined.projects).toMatchObject(expectedProjects);
  expect(manifest).toMatchObject({
    schemaVersion: 5,
    failed: false,
    samplingMode: 'independent-project-processes',
    options: { workers: sample.requestedWorkers },
    effectiveProjects: expectedProjects,
  });
  expect(summary.schemaVersion).toBe(5);
  expect(summary.comparableFields).toMatchObject({
    workers: sample.requestedWorkers,
    samplingMode: 'independent-project-processes',
    effectiveProjects: expectedProjects,
  });

  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  expect(report).toContain(`Requested max workers per project process: ${sample.requestedWorkers}`);
  expect(report).toContain(
    `| ${sample.project} | ${sample.requestedWorkers} | ${sample.actualWorkers} | threads | ${sample.groupOrder} |`,
  );
  expect(report).toContain('not regular `test:run` scheduling');
}

function unconfirmedChildFailure(): ChildProcessLifecycleError {
  return new ChildProcessLifecycleError({
    command: process.execPath,
    args: [],
    pid: 12345,
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    errors: [],
    directChild: { state: 'unconfirmed' },
    stdio: 'closed',
    outputTruncated: false,
    outputTruncatedAt: null,
    reason: 'cancelled',
    timeoutMs: SAMPLE_TIMEOUT_MS,
    killGraceMs: 0,
    exitConfirmMs: 0,
    killSignals: [],
    killAttempts: [],
    killErrors: [],
    cleanup: 'closed',
    resourceEvidence: { state: 'not_configured' },
  }, new Error('controlled cancellation'));
}

async function finishProtectedCase<T>(
  dir: string,
  retention: RetentionScope,
  runAndConfirm: () => Promise<T>,
): Promise<T> {
  const retainAndThrow = (primary: unknown): never => {
    try {
      retention.retain({ code: 'test_failed', error: primary });
    } catch (recording) {
      throw new AggregateError(
        [primary, recording],
        'Test and retention recording failed',
        { cause: primary },
      );
    }
    throw primary;
  };
  return withCleanupPreservingError(async () => {
    try {
      const value = await runAndConfirm();
      retention.complete();
      return value;
    } catch (primary) {
      return retainAndThrow(primary);
    }
  }, async () => {
    try {
      await cleanupTempDir(dir);
    } catch (cleanup) {
      return retainAndThrow(cleanup);
    }
  });
}

async function runSampleCase(
  sample: SampleCase,
  signal: AbortSignal,
  execute: typeof runChildProcess = runChildProcess,
): Promise<string> {
  const repoRoot = path.resolve(__dirname, '../..');
  const { sampleRoot, hostTmpDir, retention } = createSampleRepository(repoRoot);
  return finishProtectedCase(sampleRoot, retention, async () => {
    const runDir = await runSample(sample, signal, sampleRoot, hostTmpDir, execute);
    expectWorkerFacts(runDir, sample);
    return sampleRoot;
  });
}

function expectIndependentTeardownAndReclaimPreserve(runRoot: string, sampleRoot: string): void {
  const sampleBytes = fs.readFileSync(path.join(sampleRoot, 'package.json'));
  const owner = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  expect(owner.status).toBe(0);
  const manifest = {
    invocationId: 'controlled-cost-failure',
    pid: owner.pid,
    worktree: path.join(runRoot, 'removed-worktree'),
    startedAt: new Date().toISOString(),
    runRoot,
  };
  fs.writeFileSync(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest));
  const teardownSource = `
    import fs from 'node:fs';
    import { createRunRootTeardown } from ${JSON.stringify(externalGlobalSetupModuleUrl(runRoot))};
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    await createRunRootTeardown(manifest)();
  `;
  const teardown = spawnSync(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e', teardownSource,
    path.join(runRoot, 'manifest.json'),
  ], { encoding: 'utf8', timeout: EXTERNAL_CONSUMER_TIMEOUT_MS });
  expect(teardown.status, `${teardown.stdout}\n${teardown.stderr}`).toBe(1);
  expect(teardown.stderr).toContain('test_failed');
  expect(fs.readFileSync(path.join(sampleRoot, 'package.json'))).toEqual(sampleBytes);

  const stale = new Date(Date.now() - RECLAIM_STALE_AGE_MS);
  fs.utimesSync(runRoot, stale, stale);
  const reclaimSource = `
    import { reclaimStaleRunRoots } from ${JSON.stringify(externalGlobalSetupModuleUrl(runRoot))};
    reclaimStaleRunRoots(process.argv[1], 'next-invocation');
  `;
  const reclaim = spawnSync(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e', reclaimSource, path.dirname(runRoot),
  ], { encoding: 'utf8', timeout: EXTERNAL_CONSUMER_TIMEOUT_MS });
  expect(reclaim.status, `${reclaim.stdout}\n${reclaim.stderr}`).toBe(0);
  expect(fs.readFileSync(path.join(sampleRoot, 'package.json'))).toEqual(sampleBytes);
}

describe('test-cost resolved worker facts', () => {
  const cases: SampleCase[] = [
    {
      project: 'fast',
      filter: 'tests/utils/test-cost-baseline.test.ts',
      requestedWorkers: 1,
      actualWorkers: 1,
      groupOrder: 0,
    },
    {
      project: 'resource',
      filter: 'tests/foundation/snapshot/version-export.test.ts',
      requestedWorkers: 4,
      actualWorkers: 2,
      groupOrder: 1,
    },
  ];

  for (const sample of cases) {
    it(`${sample.project}: requested ${sample.requestedWorkers}, resolved ${sample.actualWorkers}`, async context => {
      const sampleRoot = await runSampleCase(sample, context.signal);
      expect(fs.existsSync(sampleRoot)).toBe(false);
    });
  }

  it.each([
    ['unconfirmed child exit', unconfirmedChildFailure()],
    ['failed sample assertion', new Error('controlled sample assertion failure')],
  ])('preserves the caller-owned sample root after %s', async (_name, failure) => {
    const isolatedRunRoot = await createTrackedTempDir('cost-controlled-retention-');
    const originalRunRoot = process.env.CHESTNUT_RUN_ROOT;
    process.env.CHESTNUT_RUN_ROOT = isolatedRunRoot;
    let sampleRoot = '';
    const execute: typeof runChildProcess = async (_command, _args, options) => {
      sampleRoot = options.cwd ?? '';
      throw failure;
    };

    try {
      await expect(runSampleCase(cases[0], new AbortController().signal, execute)).rejects.toBe(failure);
      expect(sampleRoot).not.toBe('');
      expect(fs.existsSync(sampleRoot)).toBe(true);
      expectIndependentTeardownAndReclaimPreserve(isolatedRunRoot, sampleRoot);
    } finally {
      // The injected executor started no real process; remove this deliberately retained sandbox directly.
      if (sampleRoot) {
        fs.rmSync(sampleRoot, { recursive: true, force: true });
        untrackTempDir(sampleRoot);
      }
      if (originalRunRoot === undefined) delete process.env.CHESTNUT_RUN_ROOT;
      else process.env.CHESTNUT_RUN_ROOT = originalRunRoot;
      await cleanupTempDir(isolatedRunRoot);
    }
  });
});
