import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withYamlConfigLock, ConfigStoreError } from '../../../src/foundation/config-store/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const FIXTURE_SRC = path.resolve(
  process.cwd(), 'tests/foundation/config-store/fixtures/lock-holder.ts',
);
const supported = process.platform === 'darwin' || process.platform === 'linux';
const WAIT_LIMIT_MS = 30_000;
const WAIT_POLL_MS = 10;
const CONTENTION_TIMEOUT_MS = 150;
const CONTENTION_POLL_MS = 10;

function resolveEsbuildBin(): string {
  const pnpmDir = path.resolve(process.cwd(), 'node_modules/.pnpm');
  const candidates = fs.readdirSync(pnpmDir).filter(name => name.startsWith('esbuild@')).sort();
  for (const candidate of candidates) {
    const bin = path.join(pnpmDir, candidate, 'node_modules/esbuild/bin/esbuild');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('esbuild bin not found under node_modules/.pnpm');
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
interface ChildHandle {
  proc: ChildProcess;
  result: ChildResult;
  done: Promise<void>;
}

let bundleDir: string;
let fixtureBundle: string;
let tempDir: string;
let configPath: string;
const liveChildren = new Set<ChildProcess>();

beforeAll(async () => {
  bundleDir = await createTrackedTempDir('config-lock-fixture-build-');
  fixtureBundle = path.join(bundleDir, 'lock-holder.mjs');
  execFileSync(resolveEsbuildBin(), [
    FIXTURE_SRC,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    `--outfile=${fixtureBundle}`,
  ], { stdio: 'pipe' });
}, 60_000);

beforeEach(async () => {
  tempDir = await createTrackedTempDir('config-lock-process-');
  configPath = path.join(tempDir, 'config.yaml');
});

afterEach(async () => {
  const remaining = [...liveChildren];
  for (const child of remaining) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(remaining.map(child => new Promise<void>(resolve => {
    child.once('close', () => resolve());
  })));
  liveChildren.clear();
  await cleanupTempDir(tempDir);
});

afterAll(async () => {
  await cleanupTempDir(bundleDir);
});

const deps = { fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }) };

function startHolder(mode: 'hold' | 'exit-with-lock'): ChildHandle {
  const barrierDir = path.join(tempDir, `barrier-${mode}`);
  fs.mkdirSync(barrierDir, { recursive: true });
  const scenarioPath = path.join(barrierDir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ configPath, barrierDir, mode }));
  const proc = spawn(process.execPath, [fixtureBundle, scenarioPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  liveChildren.add(proc);
  const result: ChildResult = { code: null, signal: null, stdout: '', stderr: '' };
  proc.stdout!.on('data', (data: Buffer) => { result.stdout += data.toString(); });
  proc.stderr!.on('data', (data: Buffer) => { result.stderr += data.toString(); });
  const done = new Promise<void>(resolve => {
    proc.once('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      liveChildren.delete(proc);
      resolve();
    });
  });
  return { proc, result, done };
}

function childDetail(handle: ChildHandle): string {
  return `pid=${handle.proc.pid}; code=${handle.result.code}; signal=${handle.result.signal}\n` +
    `stdout=${handle.result.stdout}\nstderr=${handle.result.stderr}`;
}

async function waitForReady(handle: ChildHandle): Promise<{ pid: number; lockRaw: string }> {
  const readyPath = path.join(tempDir, 'barrier-hold', 'ready.json');
  const alternatePath = path.join(tempDir, 'barrier-exit-with-lock', 'ready.json');
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const candidate = fs.existsSync(readyPath) ? readyPath : alternatePath;
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')) as { pid: number; lockRaw: string };
    }
    if (handle.result.code !== null || handle.result.signal !== null) {
      throw new Error(`holder exited before ready\n${childDetail(handle)}`);
    }
    if (Date.now() >= deadline) throw new Error(`ready barrier timeout\n${childDetail(handle)}`);
    await new Promise<void>(resolve => setTimeout(resolve, WAIT_POLL_MS));
  }
}

function releaseHolder(mode: 'hold' | 'exit-with-lock'): void {
  fs.writeFileSync(path.join(tempDir, `barrier-${mode}`, 'release'), 'release');
}

type EvidenceRecord = {
  event: string;
  lockRaw: string;
  decoded?: { kind: string };
  outcome: { kind: string; reason?: string };
  decision: string;
};

function readEvidence(): EvidenceRecord[] {
  const evidenceName = 'config.yaml.lock-observations';
  const freshFs = new NodeFileSystem({ baseDir: tempDir });
  if (!fs.existsSync(path.join(tempDir, evidenceName))) return [];
  return freshFs.listSync(evidenceName, { recursive: true })
    .filter(entry => entry.isFile && /^\d{6}\.json$/.test(entry.name))
    .map(entry => JSON.parse(freshFs.readSync(entry.path)) as EvidenceRecord);
}

describe.skipIf(!supported)('ConfigStore real child process observations', () => {
  it('a ready live holder excludes a competitor; a file release barrier then permits acquisition', async () => {
    const holder = startHolder('hold');
    const ready = await waitForReady(holder);
    expect(ready.pid).toBe(holder.proc.pid);
    expect(JSON.parse(ready.lockRaw)).toMatchObject({ pid: holder.proc.pid });
    let competingCalls = 0;

    let contentionError: unknown;
    try {
      await withYamlConfigLock(deps, configPath, () => { competingCalls += 1; }, {
        acquireTimeoutMs: CONTENTION_TIMEOUT_MS,
        staleMs: 0,
        pollMs: CONTENTION_POLL_MS,
      });
    } catch (error) {
      contentionError = error;
    }
    expect(contentionError).toBeInstanceOf(ConfigStoreError);
    expect((contentionError as ConfigStoreError).code).toBe('lock_timeout');
    expect(competingCalls).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(ready.lockRaw);

    releaseHolder('hold');
    await holder.done;
    expect(holder.result.code, childDetail(holder)).toBe(0);
    expect(holder.result.stdout).toContain('LOCK_HOLDER|ok');
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);

    let acquiredAfterRelease = 0;
    await withYamlConfigLock(deps, configPath, () => { acquiredAfterRelease += 1; });
    expect(acquiredAfterRelease).toBe(1);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
  });

  it('after child close, reclaims its legacy lock and retains rereadable gone evidence after release', async () => {
    const holder = startHolder('exit-with-lock');
    const ready = await waitForReady(holder);
    await holder.done;
    expect(holder.result.code, childDetail(holder)).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(ready.lockRaw);
    let calls = 0;

    await withYamlConfigLock(deps, configPath, () => { calls += 1; }, {
      acquireTimeoutMs: WAIT_LIMIT_MS,
      staleMs: 0,
      pollMs: CONTENTION_POLL_MS,
    });

    expect(calls).toBe(1);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    const records = readEvidence();
    const gone = records.find(record =>
      record.event === 'holder_observation' && record.outcome.kind === 'gone');
    expect(gone, JSON.stringify(records)).toBeDefined();
    expect(gone).toMatchObject({
      lockRaw: ready.lockRaw,
      decoded: { kind: 'decoded' },
      outcome: { kind: 'gone', reason: 'absent' },
      decision: 'consider_reclaim',
    });
    expect(JSON.parse(JSON.stringify(gone))).toEqual(gone);
    // A successful release does not clean up the process evidence.
    expect(readEvidence()).toEqual(records);
  });
});
