import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { runChildProcess } from './child-process.js';

const CHILD_TIMEOUT_MS = 25_000;
const PROJECT_NAMES = [
  'fast',
  'resource',
  'arch-compile',
  'isolated',
  'integration-process',
  'integration-io',
  'infra',
] as const;

type ProjectName = typeof PROJECT_NAMES[number];

interface ResolvedProject {
  name: ProjectName;
  maxWorkers: number;
  pool: string;
  isolate: boolean;
  groupOrder: number;
  fileParallelism?: boolean;
  testTimeout: number;
  hookTimeout: number;
}

interface Observation {
  vitestVersion: string;
  projects: ResolvedProject[];
  files: Array<[ProjectName, string]>;
}

interface WorkerCase {
  name: string;
  env?: string;
  legacyEnv?: string;
  args?: string[];
  serial?: boolean;
  allOne?: boolean;
}

const DEFAULT_CAPS: Record<ProjectName, number> = {
  fast: Math.min(os.cpus().length, 4),
  resource: 2,
  'arch-compile': 2,
  isolated: 2,
  'integration-process': 2,
  'integration-io': 2,
  infra: 1,
};

const EXPECTED_TOPOLOGY: Record<ProjectName, Omit<ResolvedProject,
  'name' | 'maxWorkers' | 'fileParallelism'>> = {
  fast: { pool: 'threads', isolate: false, groupOrder: 0, testTimeout: 15_000, hookTimeout: 10_000 },
  resource: { pool: 'threads', isolate: false, groupOrder: 1, testTimeout: 15_000, hookTimeout: 10_000 },
  'arch-compile': { pool: 'threads', isolate: true, groupOrder: 1, testTimeout: 60_000, hookTimeout: 15_000 },
  isolated: { pool: 'threads', isolate: true, groupOrder: 1, testTimeout: 15_000, hookTimeout: 10_000 },
  'integration-process': { pool: 'threads', isolate: true, groupOrder: 1, testTimeout: 30_000, hookTimeout: 15_000 },
  'integration-io': { pool: 'threads', isolate: true, groupOrder: 1, testTimeout: 15_000, hookTimeout: 10_000 },
  infra: { pool: 'threads', isolate: true, groupOrder: 2, testTimeout: 60_000, hookTimeout: 30_000 },
};

const CASES: WorkerCase[] = [
  { name: 'default' },
  { name: 'env=1', env: '1', allOne: true },
  { name: 'env=4', env: '4' },
  { name: 'env=64', env: '64' },
  { name: 'env=0', env: '0' },
  { name: 'env=invalid', env: 'invalid' },
  { name: 'env=-2', env: '-2' },
  { name: 'CLI maxWorkers=1', args: ['--max-workers=1'] },
  { name: 'CLI maxWorkers=64', args: ['--max-workers=64'] },
  { name: 'CLI maxWorkers=100%', args: ['--max-workers=100%'] },
  { name: 'env=4 and CLI maxWorkers=1', env: '4', args: ['--max-workers=1'] },
  { name: 'fileParallelism=false', args: ['--no-file-parallelism'], serial: true, allOne: true },
  { name: 'env=64 and fileParallelism=false', env: '64', args: ['--no-file-parallelism'], serial: true, allOne: true },
  { name: 'legacy VITEST_MAX_THREADS=1', legacyEnv: '1' },
];

async function observe(workerCase: WorkerCase, context: TestContext): Promise<Observation> {
  const repoRoot = path.resolve(__dirname, '../..');
  const result = await runChildProcess(
    process.execPath,
    [path.join(repoRoot, 'tests/fixtures/vitest-worker-config.mjs'), ...(workerCase.args ?? [])],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VITEST_MAX_WORKERS: workerCase.env,
        VITEST_MAX_THREADS: workerCase.legacyEnv,
      },
      timeoutMs: CHILD_TIMEOUT_MS,
      signal: context.signal,
    },
  );
  expect(result.status, `worker fixture failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Observation;
}

function expectResolvedConfiguration(observation: Observation, workerCase: WorkerCase): void {
  expect(observation.vitestVersion).toBe('4.1.11');
  expect(observation.projects.map(project => project.name)).toEqual(PROJECT_NAMES);
  for (const project of observation.projects) {
    const expectedWorkers = workerCase.allOne ? 1 : DEFAULT_CAPS[project.name];
    expect(project, project.name).toMatchObject({
      ...EXPECTED_TOPOLOGY[project.name],
      maxWorkers: expectedWorkers,
    });
    expect(project.fileParallelism, project.name).toBe(workerCase.serial ? false : undefined);
    expect(Number.isInteger(project.maxWorkers), project.name).toBe(true);
    expect(project.maxWorkers, project.name).toBeGreaterThan(0);
  }

  expect(observation.files.length).toBeGreaterThan(0);
  const fileKeys = observation.files.map(([project, moduleId]) => `${project}\0${moduleId}`);
  expect(new Set(fileKeys).size).toBe(fileKeys.length);
}

describe('resolved Vitest project worker caps', () => {
  let defaultFiles: Observation['files'] | undefined;

  for (const workerCase of CASES) {
    it(workerCase.name, async context => {
      const observation = await observe(workerCase, context);
      expectResolvedConfiguration(observation, workerCase);
      if (workerCase.name === 'default') defaultFiles = observation.files;
      if (workerCase.name === 'env=4') {
        expect(defaultFiles).toBeDefined();
        expect(observation.files).toEqual(defaultFiles);
      }
    });
  }
});
