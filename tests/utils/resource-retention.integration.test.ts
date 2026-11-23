import fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunManifest } from '../../.config/vitest-global-setup.js';
import {
  beginRetentionScope,
  inspectRetention,
  RETENTION_RECORD_FILENAME,
  RetentionWriteError,
  type RetentionDecision,
} from './resource-retention.js';
import {
  cleanupAllTrackedDirs,
  cleanupTempDir,
  cleanupTempDirSync,
  createScopedTempDirSync,
  createTrackedTempDirSync,
  getTrackedDirs,
  untrackTempDir,
} from './temp.js';

const POLL_MS = 20;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const hosts: string[] = [];
const processGroups = new Set<number>();
const parentRunRoot = process.env.CHESTNUT_RUN_ROOT;
const retentionModuleUrl = pathToFileURL(path.resolve(__dirname, 'resource-retention.ts')).href;

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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, message: string, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(POLL_MS);
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function makeRunRoot(name: string): string {
  const host = createTrackedTempDirSync('retention-integration-host-');
  hosts.push(host);
  const runRoot = path.join(host, `chestnut-run-${name}`);
  fs.mkdirSync(runRoot);
  process.env.CHESTNUT_RUN_ROOT = runRoot;
  return runRoot;
}

function manifest(runRoot: string, invocationId: string): RunManifest {
  const owner = spawnSync(process.execPath, ['-e', '']);
  expect(owner.status).toBe(0);
  return {
    invocationId,
    pid: owner.pid,
    worktree: path.join(path.dirname(runRoot), `removed-worktree-${invocationId}`),
    startedAt: new Date().toISOString(),
    runRoot,
  };
}

function makeStale(runRoot: string): void {
  const stale = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(runRoot, stale, stale);
}

function externalInspect(runRoot: string, targetPath?: string): RetentionDecision {
  const source = `
    import { inspectRetention } from ${JSON.stringify(retentionModuleUrl)};
    const decision = inspectRetention(process.argv[1], process.argv[2]);
    process.stdout.write(JSON.stringify(decision));
  `;
  const result = spawnSync(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e', source, runRoot, targetPath,
  ], { encoding: 'utf8', timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as RetentionDecision;
}

function externalTeardown(runRoot: string, expectedStatus: number): string {
  const source = `
    import fs from 'node:fs';
    import { createRunRootTeardown } from ${JSON.stringify(externalGlobalSetupModuleUrl(runRoot))};
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    await createRunRootTeardown(manifest)();
  `;
  const result = spawnSync(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e', source,
    path.join(runRoot, 'manifest.json'),
  ], { encoding: 'utf8', timeout: 10_000 });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedStatus);
  return `${result.stdout}\n${result.stderr}`;
}

function externalReclaim(runRoot: string): void {
  const source = `
    import { reclaimStaleRunRoots } from ${JSON.stringify(externalGlobalSetupModuleUrl(runRoot))};
    reclaimStaleRunRoots(process.argv[1], 'next-invocation');
  `;
  const result = spawnSync(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e', source, path.dirname(runRoot),
  ], { encoding: 'utf8', timeout: 10_000 });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const pgid of processGroups) {
    if (groupAlive(pgid)) {
      try { process.kill(-pgid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await waitFor(() => !groupAlive(pgid), `process group ${pgid} did not exit`);
  }
  processGroups.clear();
  if (parentRunRoot === undefined) delete process.env.CHESTNUT_RUN_ROOT;
  else process.env.CHESTNUT_RUN_ROOT = parentRunRoot;
  while (hosts.length > 0) {
    const host = hosts.pop()!;
    for (const tracked of [...getTrackedDirs()]) {
      if (tracked === host || tracked.startsWith(`${host}${path.sep}`)) untrackTempDir(tracked);
    }
    fs.rmSync(host, { recursive: true, force: true });
  }
});

describe('resource retention integration', () => {
  it('ordinary failure survives cleanup teardown and reclaim', async () => {
    const runRoot = makeRunRoot('ordinary-failure');
    const { dir, retention } = createScopedTempDirSync('sample evidence-');
    const sample = path.join(dir, 'sample.bin');
    const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    fs.writeFileSync(sample, bytes);
    const primary = new Error('ordinary non-zero sample');
    retention.retain({ code: 'test_failed', error: primary, evidence: { status: 7 } });
    const control = path.join(runRoot, 'unprotected-control');
    fs.mkdirSync(control);
    const controlSample = path.join(control, 'sample.bin');
    fs.writeFileSync(controlSample, bytes);

    await cleanupTempDir(dir);
    expect(fs.readFileSync(sample)).toEqual(bytes);
    cleanupTempDirSync(dir);
    expect(fs.readFileSync(sample)).toEqual(bytes);
    await cleanupAllTrackedDirs();
    expect(fs.readFileSync(sample)).toEqual(bytes);
    await cleanupTempDir(control);
    expect(fs.existsSync(controlSample)).toBe(false);

    const runManifest = manifest(runRoot, 'ordinary-failure');
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), JSON.stringify(runManifest));
    expect(externalTeardown(runRoot, 1)).toContain('test_failed');
    expect(externalInspect(runRoot, dir)).toMatchObject({ kind: 'preserve', reasons: ['test_failed'] });
    makeStale(runRoot);
    externalReclaim(runRoot);
    expect(fs.readFileSync(sample)).toEqual(bytes);
  });

  it('unconfirmed group preserves its live cwd', async () => {
    const runRoot = makeRunRoot('unconfirmed-group');
    const { dir, retention } = createScopedTempDirSync('group-cwd-');
    const readyPath = path.join(runRoot, 'ready.json');
    const exitedPath = path.join(runRoot, 'exited.json');
    const fixture = path.resolve(__dirname, '../fixtures/resource-retention-child.mjs');
    const wrapper = spawn(process.execPath, [fixture, readyPath, exitedPath, dir, '5000'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (wrapper.pid === undefined) throw new Error('group wrapper did not publish a PID');
    processGroups.add(wrapper.pid);
    let stdout = '';
    let stderr = '';
    wrapper.stdout.setEncoding('utf8');
    wrapper.stderr.setEncoding('utf8');
    wrapper.stdout.on('data', chunk => { stdout += chunk; });
    wrapper.stderr.on('data', chunk => { stderr += chunk; });
    const wrapperExited = new Promise<void>((resolve, reject) => {
      wrapper.once('exit', () => resolve());
      wrapper.once('error', reject);
    });
    await waitFor(() => fs.existsSync(readyPath), `group child was not ready: ${stderr}`);
    await wrapperExited;
    const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8')) as {
      wrapperPid: number;
      processGroupId: number;
      groupChildPid: number;
      cwd: string;
    };
    expect(ready.wrapperPid).toBe(wrapper.pid);
    expect(ready.processGroupId).toBe(wrapper.pid);
    expect(fs.realpathSync(ready.cwd)).toBe(fs.realpathSync(dir));
    expect(stdout).toContain('"groupChildPid"');
    expect(groupAlive(ready.processGroupId)).toBe(true);

    retention.retain({
      code: 'unconfirmed_process_group',
      evidence: {
        identity: { wrapperPid: ready.wrapperPid, processGroupId: ready.processGroupId },
        outcome: { wrapper: 'exited', processGroup: 'alive', groupChildPid: ready.groupChildPid },
      },
    });
    expect(inspectRetention(runRoot, dir)).toMatchObject({
      kind: 'preserve',
      scopeIds: [retention.id],
      reasons: ['unconfirmed_process_group'],
    });
    await cleanupTempDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    const raw = fs.readFileSync(path.join(runRoot, RETENTION_RECORD_FILENAME), 'utf8');
    expect(raw).toContain('unconfirmed_process_group');
    expect(raw).not.toContain('unconfirmed_direct_child');

    process.kill(-ready.processGroupId, 'SIGTERM');
    await waitFor(() => fs.existsSync(exitedPath), 'finite group child did not acknowledge termination');
    await waitFor(() => !groupAlive(ready.processGroupId), 'process group remained alive after SIGTERM');
    processGroups.delete(ready.processGroupId);
    expect(JSON.parse(fs.readFileSync(exitedPath, 'utf8'))).toMatchObject({ pid: ready.groupChildPid });
  });

  it('failed retention append leaves pending scope protected', async () => {
    const runRoot = makeRunRoot('failed-append');
    const { dir, retention } = createScopedTempDirSync('pending-after-write-failure-');
    fs.writeFileSync(path.join(dir, 'evidence'), 'original bytes');
    const primary = new Error('primary assertion');
    vi.spyOn(fs, 'writeSync').mockReturnValueOnce(0);
    let recording: unknown;
    try {
      retention.retain({ code: 'test_failed', error: primary });
    } catch (error) {
      recording = error;
    }
    expect(recording).toBeInstanceOf(RetentionWriteError);
    expect(recording).toMatchObject({ publication: 'indeterminate' });
    const combined = new AggregateError(
      [primary, recording],
      'Test and retention recording failed',
      { cause: primary },
    );
    expect(combined.errors).toEqual([primary, recording]);
    expect(combined.cause).toBe(primary);
    vi.restoreAllMocks();

    expect(externalInspect(runRoot, dir)).toMatchObject({ kind: 'preserve', reasons: ['scope_pending'] });
    await cleanupTempDir(dir);
    expect(fs.readFileSync(path.join(dir, 'evidence'), 'utf8')).toBe('original bytes');
  });

  it('completed success is cleaned across all consumers', async () => {
    const runRoot = makeRunRoot('completed-success');
    const asyncScope = createScopedTempDirSync('async-success-');
    const syncScope = createScopedTempDirSync('sync-success-');
    const allScope = createScopedTempDirSync('all-success-');
    for (const scope of [asyncScope, syncScope, allScope]) scope.retention.complete();
    untrackTempDir(path.dirname(runRoot));

    await cleanupTempDir(asyncScope.dir);
    cleanupTempDirSync(syncScope.dir);
    await cleanupAllTrackedDirs();
    expect(fs.existsSync(asyncScope.dir)).toBe(false);
    expect(fs.existsSync(syncScope.dir)).toBe(false);
    expect(fs.existsSync(allScope.dir)).toBe(false);
    const runManifest = manifest(runRoot, 'completed-success');
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), JSON.stringify(runManifest));
    externalTeardown(runRoot, 0);
    expect(fs.existsSync(runRoot)).toBe(false);
  });

  it('keeps concurrent completed streams valid and a later truncation conservative', async () => {
    const runRoot = makeRunRoot('multi-writer');
    const writerSource = `
      import { beginRetentionScope } from ${JSON.stringify(retentionModuleUrl)};
      const scope = beginRetentionScope({
        runRoot: process.argv[1], protectedPaths: [process.argv[2]], label: process.argv[2],
      });
      scope.complete();
    `;
    const writers = Array.from({ length: 4 }, (_, index) => {
      const child = spawn(process.execPath, [
        '--experimental-transform-types', '--input-type=module', '-e', writerSource,
        runRoot, path.join(runRoot, `writer-${index}`),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      return new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', status => {
          if (status === 0) resolve();
          else reject(new Error(`retention writer exited ${status}: ${stderr}`));
        });
      });
    });
    await Promise.all(writers);
    expect(externalInspect(runRoot)).toEqual({ kind: 'allow' });
    const record = path.join(runRoot, RETENTION_RECORD_FILENAME);
    const before = fs.readFileSync(record);
    fs.appendFileSync(record, '{"version":1,"type":"scope_begin"');
    expect(externalInspect(runRoot).kind).toBe('indeterminate');
    expect(fs.readFileSync(record).subarray(0, before.length)).toEqual(before);
  });

  it('protects only the matching scope when a sibling prefix is cleaned', async () => {
    const runRoot = makeRunRoot('path-scope');
    const retained = beginRetentionScope({
      runRoot,
      protectedPaths: [path.join(runRoot, 'sample')],
      label: 'retained sample',
    });
    retained.retain({ code: 'test_failed' });
    const sibling = path.join(runRoot, 'sample-other');
    fs.mkdirSync(sibling);
    await cleanupTempDir(sibling);
    expect(fs.existsSync(sibling)).toBe(false);
    expect(inspectRetention(runRoot)).toMatchObject({ kind: 'preserve', scopeIds: [retained.id] });
  });
});
