import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { withSkillStateLock } from '../../../src/foundation/skill-system/state-lock.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const FIXTURE_SRC = path.resolve(
  process.cwd(), 'tests/foundation/skill-system/fixtures/state-lock-holder.ts',
);
const supported = process.platform === 'darwin' || process.platform === 'linux';
const WAIT_LIMIT_MS = 30_000;
const WAIT_POLL_MS = 10;

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
type EvidenceRecord = {
  event: string;
  attemptId: string;
  sequence: number;
  lockRaw: string;
  process: {
    decoded?: { kind: string; value?: string };
    observed?: { kind: string; reason?: string; evidence?: unknown };
  };
  decision: { kind: string; reason: string } | 'stop';
};

let bundleDir: string;
let fixtureBundle: string;
let tempDir: string;
let stateDir: string;
const liveChildren = new Set<ChildProcess>();

beforeAll(async () => {
  bundleDir = await createTrackedTempDir('skill-state-lock-fixture-build-');
  fixtureBundle = path.join(bundleDir, 'state-lock-holder.mjs');
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
  tempDir = await createTrackedTempDir('skill-state-lock-process-');
  stateDir = path.join(tempDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(async () => {
  for (const child of [...liveChildren]) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all([...liveChildren].map(child => new Promise<void>(resolve => {
    child.once('close', () => resolve());
  })));
  liveChildren.clear();
  await cleanupTempDir(tempDir);
});

afterAll(async () => {
  await cleanupTempDir(bundleDir);
});

function startHolder(mode: 'hold' | 'exit-with-lock'): ChildHandle {
  const barrierDir = path.join(tempDir, `barrier-${mode}`);
  fs.mkdirSync(barrierDir, { recursive: true });
  const scenarioPath = path.join(barrierDir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ stateDir, barrierDir, mode }));
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

async function waitForReady(handle: ChildHandle, mode: 'hold' | 'exit-with-lock') {
  const readyPath = path.join(tempDir, `barrier-${mode}`, 'ready.json');
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    if (fs.existsSync(readyPath)) {
      return JSON.parse(fs.readFileSync(readyPath, 'utf8')) as { pid: number; lockRaw: string };
    }
    if (handle.result.code !== null || handle.result.signal !== null) {
      throw new Error(`holder exited before ready\n${childDetail(handle)}`);
    }
    if (Date.now() >= deadline) throw new Error(`ready barrier timeout\n${childDetail(handle)}`);
    await new Promise<void>(resolve => setTimeout(resolve, WAIT_POLL_MS));
  }
}

function releaseHolder(): void {
  fs.writeFileSync(path.join(tempDir, 'barrier-hold', 'release'), 'release');
}

/** Re-read through a fresh FileSystem, not through either competitor's instance. */
function readEvidence(): EvidenceRecord[] {
  const root = path.join(stateDir, 'state-lock-observations');
  if (!fs.existsSync(root)) return [];
  const freshFs = new NodeFileSystem({ baseDir: stateDir });
  return freshFs.listSync('state-lock-observations', { recursive: true })
    .filter(entry => entry.isFile && /^\d{6}\.json$/.test(entry.name))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => {
      const record = JSON.parse(freshFs.readSync(entry.path)) as EvidenceRecord;
      expect(JSON.parse(JSON.stringify(record))).toEqual(record);
      return record;
    });
}

async function waitForEvidence(predicate: (records: EvidenceRecord[]) => boolean): Promise<EvidenceRecord[]> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const records = readEvidence();
    if (predicate(records)) return records;
    if (Date.now() >= deadline) {
      throw new Error(`evidence barrier timeout: ${JSON.stringify(records)}`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, WAIT_POLL_MS));
  }
}

describe.skipIf(!supported)('SkillSystem real child legacy state lock', () => {
  it('a live old-format holder excludes a competitor; release permits acquisition and preserves evidence', async () => {
    const holder = startHolder('hold');
    const ready = await waitForReady(holder, 'hold');
    expect(ready.pid).toBe(holder.proc.pid);
    expect(JSON.parse(ready.lockRaw)).toMatchObject({ pid: ready.pid });
    let competingCalls = 0;
    const competitor = withSkillStateLock(new NodeFileSystem({ baseDir: stateDir }), async () => {
      competingCalls += 1;
    });

    const observed = await waitForEvidence(records => records.some(record =>
      record.event === 'holder_decision' && record.decision !== 'stop'
      && record.decision.kind === 'wait' && record.process.observed?.kind === 'unknown'));
    expect(competingCalls).toBe(0);
    expect(fs.readFileSync(path.join(stateDir, 'state.lock'), 'utf8')).toBe(ready.lockRaw);
    expect(observed[0].lockRaw).toBe(ready.lockRaw);

    releaseHolder();
    await holder.done;
    await competitor;
    expect(holder.result.code, childDetail(holder)).toBe(0);
    expect(holder.result.stdout).toContain('STATE_LOCK_HOLDER|ok');
    expect(competingCalls).toBe(1);
    expect(fs.existsSync(path.join(stateDir, 'state.lock'))).toBe(false);
    expect(readEvidence().length).toBeGreaterThanOrEqual(observed.length);
    expect(readEvidence()).toEqual(expect.arrayContaining(observed));
  });

  it('takes over only after child close, and a fresh FileSystem can reread retained gone evidence', async () => {
    const holder = startHolder('exit-with-lock');
    const ready = await waitForReady(holder, 'exit-with-lock');
    await holder.done;
    expect(holder.result.code, childDetail(holder)).toBe(0);
    expect(fs.readFileSync(path.join(stateDir, 'state.lock'), 'utf8')).toBe(ready.lockRaw);
    let calls = 0;
    let replacementRaw = '';

    await withSkillStateLock(new NodeFileSystem({ baseDir: stateDir }), async () => {
      calls += 1;
      replacementRaw = fs.readFileSync(path.join(stateDir, 'state.lock'), 'utf8');
      expect(replacementRaw).not.toBe(ready.lockRaw);
      expect(JSON.parse(replacementRaw)).toMatchObject({ pid: process.pid });
      expect(JSON.parse(replacementRaw)).not.toHaveProperty('lock_version');
    });

    expect(calls).toBe(1);
    expect(fs.existsSync(path.join(stateDir, 'state.lock'))).toBe(false);
    const records = readEvidence();
    const gone = records.find(record => record.event === 'holder_decision'
      && record.decision !== 'stop' && record.decision.kind === 'takeover'
      && record.decision.reason === 'process_gone');
    expect(gone, JSON.stringify(records)).toBeDefined();
    expect(gone).toMatchObject({
      lockRaw: ready.lockRaw,
      process: {
        decoded: { kind: 'decoded' },
        observed: { kind: 'gone', reason: 'absent' },
      },
      decision: { kind: 'takeover', reason: 'process_gone' },
    });
    expect(gone?.process.decoded?.value).toContain(`"pid":${ready.pid}`);
    expect(gone?.process.observed?.evidence).toBeDefined();
    // Successful release of the replacement generation does not clean observations.
    expect(readEvidence()).toEqual(records);
  });
});
