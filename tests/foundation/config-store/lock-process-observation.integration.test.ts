import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withYamlConfigLock, ConfigStoreError } from '../../../src/foundation/config-store/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRef,
  type ProcessRefCapture,
  type ProcessRefDecode,
} from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const FIXTURE_SRC = path.resolve(
  process.cwd(), 'tests/foundation/config-store/fixtures/lock-holder.ts',
);
const supported = process.platform === 'darwin' || process.platform === 'linux';
const WAIT_LIMIT_MS = 30_000;
const WAIT_POLL_MS = 10;
// Self capture and holder inspection each have their own bounded OS query.
const CONTENTION_TIMEOUT_MS = 5_000;
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

type EvidenceMetadata = {
  version: number;
  attemptId: string;
  sequence: number;
  atMs: number;
};
type SelfCaptureEvidence = EvidenceMetadata & {
  event: 'self_capture';
  capture: ProcessRefCapture;
};
type HolderEvidence = EvidenceMetadata & {
  event: 'holder_observation';
  lockRaw: string;
  decoded?: ProcessRefDecode;
  outcome: { kind: string; reason?: string };
  decision: string;
};
type EvidenceRecord = SelfCaptureEvidence | HolderEvidence;

type V2LockPayload = {
  lock_version: number;
  token: string;
  createdAt: string;
  observationAttemptId: string;
  holder: { kind: 'reference'; ref: string } | { kind: 'unknown' };
};

function readV2Reference(raw: string): { payload: V2LockPayload; ref: ProcessRef } {
  const payload = JSON.parse(raw) as V2LockPayload;
  expect(Object.keys(payload).sort()).toEqual([
    'createdAt', 'holder', 'lock_version', 'observationAttemptId', 'token',
  ]);
  expect(payload).toMatchObject({ lock_version: 2, holder: { kind: 'reference' } });
  expect(payload).not.toHaveProperty('pid');
  expect(payload).not.toHaveProperty('process_start_time');
  if (payload.holder.kind !== 'reference') throw new Error(`expected v2 reference: ${raw}`);
  const decoded = decodeProcessRef(payload.holder.ref);
  expect(decoded.kind, JSON.stringify(decoded)).toBe('decoded');
  if (decoded.kind !== 'decoded') throw new Error(JSON.stringify(decoded));
  return { payload, ref: decoded.value };
}

function selfCaptureFor(attemptId: string): SelfCaptureEvidence {
  const records = readEvidence();
  const record = records.find((candidate): candidate is SelfCaptureEvidence =>
    candidate.event === 'self_capture' && candidate.attemptId === attemptId);
  expect(record, JSON.stringify(records)).toBeDefined();
  if (!record) throw new Error(`missing self capture for ${attemptId}`);
  return record;
}

function readEvidence(): EvidenceRecord[] {
  const evidenceName = 'config.yaml.lock-observations';
  const freshFs = new NodeFileSystem({ baseDir: tempDir });
  if (!fs.existsSync(path.join(tempDir, evidenceName))) return [];
  return freshFs.listSync(evidenceName, { recursive: true })
    .filter(entry => entry.isFile && /^\d{6}\.json$/.test(entry.name))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => {
      const record = JSON.parse(freshFs.readSync(entry.path)) as EvidenceRecord;
      expect(JSON.parse(JSON.stringify(record))).toEqual(record);
      return record;
    });
}

describe.skipIf(!supported)('ConfigStore real child process observations', () => {
  it('a live v2 holder excludes a competitor; normal release preserves evidence and permits acquisition', async () => {
    const holder = startHolder('hold');
    const ready = await waitForReady(holder);
    expect(ready.pid).toBe(holder.proc.pid);
    const { payload, ref } = readV2Reference(ready.lockRaw);
    const alive = inspectProcessRef(ref);
    expect(alive.kind, JSON.stringify(alive)).toBe('alive');
    expect(JSON.parse(JSON.stringify(alive))).toEqual(alive);
    const childCapture = selfCaptureFor(payload.observationAttemptId);
    expect(childCapture.capture).toMatchObject({ kind: 'captured', value: ref });
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
    const aliveRecords = readEvidence().filter((record): record is HolderEvidence =>
      record.event === 'holder_observation' && record.outcome.kind === 'alive');
    expect(aliveRecords.length).toBeGreaterThan(0);
    expect(aliveRecords[0]).toMatchObject({
      lockRaw: ready.lockRaw,
      decoded: { kind: 'decoded', value: ref },
      outcome: { kind: 'alive' },
      decision: 'wait',
    });

    releaseHolder('hold');
    await holder.done;
    expect(holder.result.code, childDetail(holder)).toBe(0);
    expect(holder.result.stdout).toContain('LOCK_HOLDER|ok');
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    expect(selfCaptureFor(payload.observationAttemptId)).toEqual(childCapture);

    let acquiredAfterRelease = 0;
    await withYamlConfigLock(deps, configPath, () => { acquiredAfterRelease += 1; });
    expect(acquiredAfterRelease).toBe(1);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    expect(selfCaptureFor(payload.observationAttemptId)).toEqual(childCapture);
  });

  it('after child close, rereads its v2 reference as gone and reclaims only that generation', async () => {
    const holder = startHolder('exit-with-lock');
    const ready = await waitForReady(holder);
    const { payload: oldPayload, ref: oldRef } = readV2Reference(ready.lockRaw);
    const childCapture = selfCaptureFor(oldPayload.observationAttemptId);
    await holder.done;
    expect(holder.result.code, childDetail(holder)).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(ready.lockRaw);
    const goneBeforeAcquire = inspectProcessRef(oldRef);
    expect(goneBeforeAcquire.kind, JSON.stringify(goneBeforeAcquire)).toBe('gone');
    expect(goneBeforeAcquire).toMatchObject({ reason: 'absent' });
    expect(JSON.parse(JSON.stringify(goneBeforeAcquire))).toEqual(goneBeforeAcquire);
    let calls = 0;
    let newToken = '';
    let newAttemptId = '';

    await withYamlConfigLock(deps, configPath, () => {
      calls += 1;
      const current = readV2Reference(fs.readFileSync(`${configPath}.lock`, 'utf8'));
      newToken = current.payload.token;
      newAttemptId = current.payload.observationAttemptId;
      expect(newToken).not.toBe(oldPayload.token);
      expect(newAttemptId).not.toBe(oldPayload.observationAttemptId);
    }, {
      acquireTimeoutMs: WAIT_LIMIT_MS,
      staleMs: 0,
      pollMs: CONTENTION_POLL_MS,
    });

    expect(calls).toBe(1);
    expect(newToken).not.toBe('');
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    const records = readEvidence();
    const gone = records.find((record): record is HolderEvidence =>
      record.event === 'holder_observation' && record.outcome.kind === 'gone');
    expect(gone, JSON.stringify(records)).toBeDefined();
    expect(gone).toMatchObject({
      lockRaw: ready.lockRaw,
      decoded: { kind: 'decoded', value: oldRef },
      outcome: { kind: 'gone', reason: 'absent' },
      decision: 'consider_reclaim',
    });
    if (!gone) throw new Error('missing persisted gone observation');
    expect(selfCaptureFor(newAttemptId).capture).toMatchObject({ kind: 'captured' });
    // Successful release of the replacement generation retains both generations' evidence.
    expect(readEvidence()).toEqual(expect.arrayContaining([
      gone,
      childCapture,
      selfCaptureFor(newAttemptId),
    ]));
  });
});
