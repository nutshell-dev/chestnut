import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The production runner is plain ESM so Node can execute it without a TS loader.
// @ts-expect-error No declaration file is intentionally emitted for this CLI module.
import { parseNameStatus, resolveMergeScope, runDiff } from '../../scripts/test-diff.mjs';
// @ts-expect-error No declaration file is intentionally emitted for this CLI module.
import { supplementalSelection } from '../../scripts/test-diff-rules.mjs';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../utils/temp.js';

const INVARIANTS = 'tests/design/invariants.test.ts';
const INTEGRATION_PROJECTS = ['integration-process', 'integration-io'];
const VITEST_MODULE = fileURLToPath(import.meta.resolve('vitest'));
const VITEST_CLI = path.resolve(path.dirname(VITEST_MODULE), '../vitest.mjs');
// The outer test also owns fixture setup, Git operations and receipt checks.
const FULL_LANE_SUBPROCESS_TIMEOUT_MS = 15_000;
const FULL_LANE_TEST_TIMEOUT_MS = 20_000;
const tempDirs: string[] = [];
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Diff Runner Test',
  GIT_AUTHOR_EMAIL: 'diff-runner@example.test',
  GIT_COMMITTER_NAME: 'Diff Runner Test',
  GIT_COMMITTER_EMAIL: 'diff-runner@example.test',
};

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) cleanupTempDirSync(tempDir);
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function head(cwd: string, ref = 'HEAD'): string {
  return git(cwd, 'rev-parse', ref);
}

function commitFile(cwd: string, file: string, content: string, message = `change ${file}`): string {
  const absolute = path.join(cwd, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-m', message);
  return head(cwd);
}

function createRepository(): string {
  const tempDir = createTrackedTempDirSync('test-diff-runner-');
  tempDirs.push(tempDir);
  const cwd = path.join(tempDir, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '--initial-branch=main');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  commitFile(cwd, 'README.md', 'base\n', 'base');
  return cwd;
}

function createFeatureCommit(cwd: string, file: string, content = `${file}\n`): { base: string; head: string } {
  const base = head(cwd);
  git(cwd, 'checkout', '-b', 'feature');
  commitFile(cwd, file, content);
  return { base, head: head(cwd) };
}

function createFastForwardMerge(): { cwd: string; before: string; after: string } {
  const cwd = createRepository();
  const before = head(cwd);
  git(cwd, 'checkout', '-b', 'feature');
  commitFile(cwd, 'first.txt', 'first\n');
  const after = commitFile(cwd, 'second.txt', 'second\n');
  git(cwd, 'checkout', 'main');
  git(cwd, 'merge', '--ff-only', 'feature');
  return { cwd, before, after };
}

function createOrdinaryMerge(): {
  cwd: string;
  initial: string;
  before: string;
  after: string;
  feature: string;
} {
  const cwd = createRepository();
  const initial = head(cwd);
  git(cwd, 'checkout', '-b', 'feature');
  const feature = commitFile(cwd, 'feature.txt', 'feature\n');
  git(cwd, 'checkout', 'main');
  const before = commitFile(cwd, 'main.txt', 'main\n');
  git(cwd, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
  return { cwd, initial, before, after: head(cwd), feature };
}

interface GraphEntry {
  file: string;
  projectName: string;
}

interface HarnessOptions {
  graph?: GraphEntry[];
  listStatus?: number;
  malformedList?: boolean;
  buildStatus?: number;
  testStatus?: number;
  reporterFiles?: string[];
  reporterPassed?: number;
  omitReporter?: boolean;
}

interface ProcessResult {
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  error?: Error;
}

type Spawn = (command: string, args: string[], options: SpawnSyncOptions) => ProcessResult;

function processResult(status: number): ProcessResult {
  return {
    status,
    stdout: '',
    stderr: status === 0 ? '' : `fake pnpm exited ${status}`,
  };
}

function requiredOption(args: string[], prefix: string): string {
  const argument = args.find(arg => arg.startsWith(prefix));
  if (!argument) throw new Error(`Missing ${prefix} in fake pnpm invocation: ${args.join(' ')}`);
  return argument.slice(prefix.length);
}

function createProcessHarness(cwd: string, options: HarnessOptions = {}): {
  commands: string[];
  spawn: Spawn;
} {
  const commands: string[] = [];
  const spawn: Spawn = (command, args, spawnOptions) => {
    if (command === 'git') return spawnSync(command, args, spawnOptions);
    if (command !== 'pnpm') throw new Error(`Unexpected process: ${command}`);
    commands.push(['pnpm', ...args].join(' '));

    if (args[0] === 'exec' && args[1] === 'vitest' && args[2] === 'list') {
      if (options.listStatus !== undefined) return processResult(options.listStatus);
      const outputFile = requiredOption(args, '--json=');
      if (options.malformedList) {
        writeFileSync(outputFile, '{not-json');
        return processResult(0);
      }
      const graph = (options.graph ?? []).map(item => ({
        file: path.resolve(cwd, item.file),
        projectName: item.projectName,
      }));
      writeFileSync(outputFile, JSON.stringify(graph));
      return processResult(0);
    }
    if (args[0] === 'run' && args[1] === 'build') {
      return processResult(options.buildStatus ?? 0);
    }

    const isFull = args[0] === 'run' && args[1] === 'test:preflight';
    const isSelectedRun = args[0] === 'exec' && args[1] === 'vitest' && args[2] === 'run';
    if (!isFull && !isSelectedRun) throw new Error(`Unexpected fake pnpm invocation: ${args.join(' ')}`);

    const outputFile = requiredOption(args, '--outputFile=');
    if (!options.omitReporter) {
      const selectedFiles = args.filter(arg => arg.startsWith('./')).map(arg => arg.slice(2));
      const files = options.reporterFiles ?? (selectedFiles.length > 0 ? selectedFiles : [INVARIANTS]);
      const passed = options.reporterPassed ?? 1;
      const total = Math.max(1, passed);
      writeFileSync(outputFile, JSON.stringify({
        numPassedTests: passed,
        numFailedTests: 0,
        numPendingTests: passed === 0 ? total : 0,
        numTodoTests: 0,
        numTotalTests: total,
        success: true,
        testResults: files.map(file => ({ name: path.resolve(cwd, file) })),
      }));
    }
    return processResult(options.testStatus ?? 0);
  };
  return { commands, spawn };
}

function executeDiff(cwd: string, spawn: Spawn) {
  return runDiff({ cwd, env: GIT_ENV, spawn, tempRoot: path.dirname(cwd) });
}

function testCommands(commands: string[]): string[] {
  return commands.filter(command => (
    command.startsWith('pnpm exec vitest run') || command.startsWith('pnpm run test:preflight')
  ));
}

function createRealFullLaneFixture(): string {
  const cwd = realpathSync(createRepository());
  commitFile(cwd, 'package.json', `${JSON.stringify({
    private: true,
    type: 'module',
    scripts: { 'test:preflight': `node ${JSON.stringify(VITEST_CLI)} run` },
  }, null, 2)}\n`, 'fixture package');
  commitFile(cwd, INVARIANTS, [
    `import { expect, it } from ${JSON.stringify(VITEST_MODULE)};`,
    "it('runs through the real pnpm and Vitest path', () => { expect(1).toBe(1); });",
    '',
  ].join('\n'), 'fixture test');
  createFeatureCommit(cwd, '.config/vitest.config.ts', [
    "export default { test: { include: ['tests/**/*.test.ts'] } };",
    '',
  ].join('\n'));
  return cwd;
}

function executeRealFullLane(cwd: string, injectOldSeparator = false) {
  const harness = createProcessHarness(cwd, {
    graph: [{ file: INVARIANTS, projectName: 'fast' }],
  });
  const spawn: Spawn = (command, args, options) => {
    if (command === 'pnpm' && args[0] === 'run' && args[1] === 'test:preflight') {
      const invoked = injectOldSeparator ? [...args.slice(0, 2), '--', ...args.slice(2)] : args;
      return spawnSync(command, invoked, { ...options, timeout: FULL_LANE_SUBPROCESS_TIMEOUT_MS });
    }
    return harness.spawn(command, args, options);
  };
  return executeDiff(cwd, spawn);
}

describe('supplemental differential-test selection', () => {
  it('keeps repository invariants selected for the phase 2244 new vi.mock watchdog counterexample', () => {
    const changed = 'tests/watchdog/new-vi-mock.test.ts';
    expect(supplementalSelection([changed])).toMatchObject({
      files: [INVARIANTS],
      projects: [],
      build: false,
      full: false,
      evidence: [{ rule: 'repository-invariants', paths: [changed], files: [INVARIANTS] }],
    });
  });

  it.each(['src/watchdog.ts', 'dist/watchdog.js'])('selects integration projects and builds for %s', file => {
    expect(supplementalSelection([file])).toMatchObject({
      projects: INTEGRATION_PROJECTS,
      build: true,
      full: false,
    });
  });

  it.each([
    ['configuration', '.config/vitest.config.ts'],
    ['fixture', 'tests/fixtures/watchdog.json'],
    ['unknown non-documentation', 'tools/unknown.yaml'],
  ])('requires full validation for %s changes', (_label, file) => {
    expect(supplementalSelection([file])).toMatchObject({ full: true, build: true });
  });

  it('retains deleted paths and both sides of renamed paths as rule evidence', () => {
    const changes = parseNameStatus(Buffer.from(
      'D\0tests/watchdog/removed.test.ts\0R100\0src/old.ts\0src/new.ts\0',
    ), 'committed');
    const rules = supplementalSelection(changes.flatMap((change: { paths: string[] }) => change.paths));
    expect(rules.files).toEqual([INVARIANTS]);
    expect(rules.projects).toEqual(INTEGRATION_PROJECTS);
    expect(rules.evidence).toContainEqual({
      rule: 'repository-invariants',
      paths: ['tests/watchdog/removed.test.ts', 'src/old.ts', 'src/new.ts'],
      files: [INVARIANTS],
    });
    expect(rules.evidence).toContainEqual({
      rule: 'runtime-or-build-input',
      paths: ['src/old.ts', 'src/new.ts'],
      projects: INTEGRATION_PROJECTS,
      build: true,
    });
  });
});

describe('NUL-delimited Git name-status parsing', () => {
  it('parses deletions and renames without dropping either pathname', () => {
    expect(parseNameStatus(Buffer.from(
      'D\0tests/design/deleted.test.ts\0R087\0tests/design/old.test.ts\0tests/design/new.test.ts\0',
    ), 'committed')).toEqual([
      { source: 'committed', status: 'D', paths: ['tests/design/deleted.test.ts'] },
      {
        source: 'committed',
        status: 'R087',
        oldPath: 'tests/design/old.test.ts',
        newPath: 'tests/design/new.test.ts',
        paths: ['tests/design/old.test.ts', 'tests/design/new.test.ts'],
      },
    ]);
  });
});

describe('post-merge scope resolution with real Git repositories', () => {
  it('covers every commit in a multi-commit fast-forward, not just the final parent', () => {
    const { cwd, before, after } = createFastForwardMerge();
    expect(head(cwd, 'HEAD^')).not.toBe(before);
    expect(resolveMergeScope({ cwd, env: GIT_ENV })).toEqual({ base: before, head: after });
    expect(git(cwd, 'diff', '--name-only', before, after).split('\n')).toEqual([
      'first.txt',
      'second.txt',
    ]);
  });

  it('accepts a fast-forward whose new tip is itself a merge commit', () => {
    const cwd = createRepository();
    const before = head(cwd);
    git(cwd, 'checkout', '-b', 'feature');
    commitFile(cwd, 'first.txt', 'first\n');
    git(cwd, 'checkout', '-b', 'side');
    commitFile(cwd, 'side.txt', 'side\n');
    git(cwd, 'checkout', 'feature');
    git(cwd, 'merge', '--no-ff', 'side', '-m', 'merge side into feature');
    const after = head(cwd);
    git(cwd, 'checkout', 'main');
    git(cwd, 'merge', '--ff-only', 'feature');

    expect(head(cwd, 'HEAD^1')).not.toBe(before);
    expect(resolveMergeScope({ cwd, env: GIT_ENV })).toEqual({ base: before, head: after });
    expect(git(cwd, 'diff', '--name-only', before, after).split('\n')).toEqual([
      'first.txt',
      'side.txt',
    ]);
  });

  it('uses ORIG_HEAD through the actual merged HEAD for an ordinary merge', () => {
    const { cwd, before, after, feature } = createOrdinaryMerge();
    expect(head(cwd, 'HEAD^1')).toBe(before);
    expect(head(cwd, 'HEAD^2')).toBe(feature);
    expect(resolveMergeScope({ cwd, env: GIT_ENV })).toEqual({ base: before, head: after });
    expect(git(cwd, 'diff', '--name-only', before, after)).toBe('feature.txt');
  });

  it('rejects squash merges instead of inventing a merged-tree scope', () => {
    const cwd = createRepository();
    expect(() => resolveMergeScope({ cwd, env: GIT_ENV, hookKind: '1' })).toThrow(
      'squash merge has no merged HEAD',
    );
  });

  it('rejects tracked and untracked dirt after a merge', () => {
    const { cwd } = createFastForwardMerge();
    writeFileSync(path.join(cwd, 'README.md'), 'dirty\n');
    expect(() => resolveMergeScope({ cwd, env: GIT_ENV })).toThrow('tracked or untracked changes');

    git(cwd, 'restore', '--source=HEAD', '--', 'README.md');
    writeFileSync(path.join(cwd, 'untracked.txt'), 'dirty\n');
    expect(() => resolveMergeScope({ cwd, env: GIT_ENV })).toThrow('tracked or untracked changes');
  });

  it('rejects ORIG_HEAD when it does not match the previous HEAD reflog entry', () => {
    const { cwd, initial } = createOrdinaryMerge();
    git(cwd, 'update-ref', 'ORIG_HEAD', initial);
    expect(() => resolveMergeScope({ cwd, env: GIT_ENV })).toThrow(
      'ORIG_HEAD does not match the previous HEAD reflog entry',
    );
  });
});

describe('differential runner with real Git and fake pnpm processes', () => {
  it('uses main as the default baseline and passes the resolved commit to Vitest list', () => {
    const cwd = createRepository();
    const { base, head: after } = createFeatureCommit(cwd, 'docs/default-base.md');
    const harness = createProcessHarness(cwd, {
      graph: [{ file: INVARIANTS, projectName: 'fast' }],
    });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt).toMatchObject({
      outcome: 'passed',
      baseRef: 'main',
      base,
      head: after,
    });
    expect(harness.commands[0]).toContain(`--changed=${base}`);
  });

  it('leaves a non-empty change with zero selected tests unverified', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'README.md', 'documentation only\n');
    const harness = createProcessHarness(cwd);
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('unverified');
    expect(receipt.changes.length).toBeGreaterThan(0);
    expect(receipt.reason).toContain('selected no tests');
    expect(receipt.executions).toEqual([]);
    expect(harness.commands).toHaveLength(1);
    expect(testCommands(harness.commands)).toEqual([]);
  });

  it('actually schedules and verifies invariants when the phase 2244 watchdog change has an empty graph', () => {
    const cwd = createRepository();
    createFeatureCommit(
      cwd,
      'tests/watchdog/new-vi-mock.test.ts',
      "import { vi } from 'vitest';\nvi.mock('node:fs');\n",
    );
    const harness = createProcessHarness(cwd, { graph: [] });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('passed');
    expect(receipt.graphSelection).toEqual([]);
    expect(receipt.explicitRules.files).toEqual([INVARIANTS]);
    expect(receipt.lanes).toEqual([expect.objectContaining({
      kind: 'files',
      projectName: 'fast',
      files: [INVARIANTS],
    })]);
    expect(receipt.executions).toHaveLength(1);
    expect(receipt.executions[0].execution.command).toContain(`./${INVARIANTS}`);
    expect(receipt.executions[0].execution.report.files).toEqual([path.resolve(cwd, INVARIANTS)]);
  });

  it('runs the build before integration lanes selected by a src change', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'src/watchdog.ts', 'export const watchdog = true;\n');
    const harness = createProcessHarness(cwd);
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('passed');
    expect(receipt.build).toEqual({ command: 'pnpm run build', exitCode: 0 });
    const buildIndex = harness.commands.indexOf('pnpm run build');
    const integrationIndex = harness.commands.findIndex(command => (
      command.includes('--project=integration-process')
    ));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(integrationIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(integrationIndex);
  });

  it('does not run selected tests after a build failure', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'src/watchdog.ts', 'export const watchdog = true;\n');
    const harness = createProcessHarness(cwd, { buildStatus: 1 });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt).toMatchObject({
      outcome: 'failed',
      build: { command: 'pnpm run build', exitCode: 1 },
      executions: [],
    });
    expect(receipt.reason).toContain('Build failed');
    expect(testCommands(harness.commands)).toEqual([]);
  });

  it('does not turn a nonzero selected-test execution into a green receipt', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'docs/execution.md');
    const harness = createProcessHarness(cwd, {
      graph: [{ file: 'tests/design/selected.test.ts', projectName: 'fast' }],
      testStatus: 1,
    });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.reason).toBe('Selected tests failed');
  });

  it('fails verification when the JSON reporter creates no output file', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'docs/missing-reporter.md');
    const harness = createProcessHarness(cwd, {
      graph: [{ file: 'tests/design/selected.test.ts', projectName: 'fast' }],
      omitReporter: true,
    });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.reason).toContain('did not create an output file');
  });

  it('does not accept a reporter receipt that omits a selected file', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'docs/missing-file.md');
    const harness = createProcessHarness(cwd, {
      graph: [{ file: 'tests/design/selected.test.ts', projectName: 'fast' }],
      reporterFiles: [INVARIANTS],
    });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('unverified');
    expect(receipt.reason).toContain('tests/design/selected.test.ts');
  });

  it('does not accept a successful execution with zero passed tests', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'docs/zero-passed.md');
    const harness = createProcessHarness(cwd, {
      graph: [{ file: 'tests/design/selected.test.ts', projectName: 'fast' }],
      reporterPassed: 0,
    });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('unverified');
    expect(receipt.reason).toBe('Selected lane executed zero tests');
  });

  it('executes exactly one full lane and verifies every required file', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, '.config/vitest.config.ts', 'export default {};\n');
    const requiredFiles = [
      'tests/design/a.test.ts',
      'tests/design/b.test.ts',
      INVARIANTS,
    ];
    const harness = createProcessHarness(cwd, {
      graph: [
        { file: 'tests/design/a.test.ts', projectName: 'fast' },
        { file: 'tests/design/b.test.ts', projectName: 'integration-io' },
      ],
      reporterFiles: requiredFiles,
    });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('passed');
    expect(receipt.lanes).toEqual([expect.objectContaining({
      kind: 'full',
      command: 'test:preflight',
      requiredFiles,
    })]);
    expect(testCommands(harness.commands)).toHaveLength(1);
    expect(testCommands(harness.commands)[0]).toMatch(/^pnpm run test:preflight /);
    expect(receipt.executions).toHaveLength(1);
    expect(receipt.executions[0].execution.report.files).toEqual(
      requiredFiles.map(file => path.resolve(cwd, file)),
    );
  });

  it('rejects a full-lane receipt that omits one of requiredFiles', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, '.config/vitest.config.ts', 'export default {};\n');
    const harness = createProcessHarness(cwd, {
      graph: [
        { file: 'tests/design/a.test.ts', projectName: 'fast' },
        { file: 'tests/design/b.test.ts', projectName: 'integration-io' },
      ],
      reporterFiles: ['tests/design/a.test.ts', INVARIANTS],
    });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('unverified');
    expect(receipt.reason).toContain('Reporter did not record selected files: tests/design/b.test.ts');
    expect(testCommands(harness.commands)).toHaveLength(1);
    expect(testCommands(harness.commands)[0]).toMatch(/^pnpm run test:preflight /);
  });

  it('rejects an unresolvable explicit baseline before invoking Vitest', () => {
    const cwd = createRepository();
    const harness = createProcessHarness(cwd);
    const receipt = runDiff({ cwd, env: GIT_ENV, spawn: harness.spawn, base: 'missing-base' });
    expect(receipt.outcome).toBe('unverified');
    expect(receipt.reason).toContain('missing-base');
    expect(harness.commands).toEqual([]);
  });

  it.each([
    ['a nonzero list exit', { listStatus: 1 }],
    ['malformed list JSON', { malformedList: true }],
  ])('does not run tests after %s', (_label, options) => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'tests/watchdog/new-vi-mock.test.ts');
    const harness = createProcessHarness(cwd, options);
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('unverified');
    expect(testCommands(harness.commands)).toEqual([]);
  });

  it('feeds untracked paths into explicit rules even when HEAD equals main', () => {
    const cwd = createRepository();
    const untracked = 'tests/watchdog/untracked-vi-mock.test.ts';
    mkdirSync(path.dirname(path.join(cwd, untracked)), { recursive: true });
    writeFileSync(path.join(cwd, untracked), "import { vi } from 'vitest';\nvi.mock('node:fs');\n");
    const harness = createProcessHarness(cwd);
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('passed');
    expect(receipt.changes).toContainEqual({ source: 'untracked', status: '??', paths: [untracked] });
    expect(receipt.explicitRules.files).toEqual([INVARIANTS]);
  });

  it('rejects dirty merge verification without invoking the selection process', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'src/watchdog.ts');
    writeFileSync(path.join(cwd, 'untracked.txt'), 'dirty\n');
    const harness = createProcessHarness(cwd);
    const receipt = runDiff({
      cwd,
      env: GIT_ENV,
      spawn: harness.spawn,
      mergeVerification: true,
    });
    expect(receipt.outcome).toBe('unverified');
    expect(receipt.reason).toContain('requires a clean');
    expect(harness.commands).toEqual([]);
  });

  it('builds before a dependency-graph integration lane even without an explicit integration rule', () => {
    const cwd = createRepository();
    createFeatureCommit(cwd, 'docs/integration-selection.md');
    const harness = createProcessHarness(cwd, {
      graph: [{ file: 'tests/cli/daemon.test.ts', projectName: 'integration-process' }],
    });
    const receipt = executeDiff(cwd, harness.spawn);
    expect(receipt.outcome).toBe('passed');
    expect(receipt.build.exitCode).toBe(0);
    expect(harness.commands.indexOf('pnpm run build')).toBeLessThan(
      harness.commands.findIndex(command => command.startsWith('pnpm exec vitest run')),
    );
  });
});

describe('full-lane reporter arguments with real pnpm and Vitest', () => {
  it('creates and consumes a JSON receipt through the forwarded reporter arguments', () => {
    const cwd = createRealFullLaneFixture();
    const receipt = executeRealFullLane(cwd);

    expect(receipt).toMatchObject({
      outcome: 'passed',
      executions: [{
        outcome: 'passed',
        execution: {
          exitCode: 0,
          report: { passed: 1, total: 1, files: [path.resolve(cwd, INVARIANTS)] },
        },
      }],
    });
    expect(receipt.executions[0].execution.command).not.toContain('--');
  }, FULL_LANE_TEST_TIMEOUT_MS);

  it('rejects a zero-exit full lane when the old separator suppresses the JSON receipt', () => {
    const cwd = createRealFullLaneFixture();
    const receipt = executeRealFullLane(cwd, true);

    expect(receipt).toMatchObject({
      outcome: 'failed',
      reason: 'Vitest JSON reporter did not create an output file',
      executions: [{ outcome: 'failed', execution: { exitCode: 0 } }],
    });
  }, FULL_LANE_TEST_TIMEOUT_MS);
});
