/**
 * Phase 2116 Step C：生产 v1 import claim 的真实进程身份与中断恢复。
 * 子进程只经 FileSystem DI 在真实 claim 写后暂停；父进程读取真实磁盘字节，
 * 验证活 holder 拒绝、进程退出后的 fail-closed/同 payload 恢复及完整证据。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { importCommand } from '../../src/cli/commands/claw-import.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  inspectProcessRef,
  type ProcessRefCapture,
} from '../../src/foundation/process-exec/index.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';
import { cleanupTempDir, createTrackedTempDir } from '../utils/temp.js';

const FIXTURE_SRC = path.resolve(
  process.cwd(), 'tests/cli/fixtures/claw-import-process-reference-child.ts',
);
const supported = process.platform === 'darwin' || process.platform === 'linux';
const WAIT_LIMIT_MS = 30_000;
const WAIT_POLL_MS = 10;

type CapturedProcessRef = Extract<ProcessRefCapture, { kind: 'captured' }>;
type V1Claim = {
  schema_version: 1;
  token: string;
  createdAt: string;
  source: string;
  target: string;
  manifestHash?: string;
  holder: CapturedProcessRef;
};
type EvidenceRecord = {
  attemptId: string;
  sequence: number;
  kind: string;
  exactRaw?: string;
  capture?: ProcessRefCapture;
};
type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
type ChildHandle = {
  proc: ChildProcess;
  barrierDir: string;
  result: ChildResult;
  done: Promise<void>;
};

let bundleDir: string;
let fixtureBundle: string;
let tempDir: string;
let originalRoot: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
const liveChildren = new Set<ChildHandle>();

function sourceDir(): string {
  return path.join(tempDir, 'src-bundle');
}
function clawDir(): string {
  return path.join(tempDir, '.chestnut', 'claws', 'alice');
}
function clawspaceDir(): string {
  return path.join(clawDir(), 'clawspace');
}
function claimPath(): string {
  return path.join(clawspaceDir(), 'src-bundle', '.import-claim');
}
function fsFactory(baseDir: string): NodeFileSystem {
  return new NodeFileSystem({ baseDir });
}
function runParentImport(): Promise<void> {
  return importCommand(makeClawCommandDeps(fsFactory), sourceDir(), 'alice');
}

function resolveEsbuildBin(): string {
  const pnpmDir = path.resolve(process.cwd(), 'node_modules/.pnpm');
  const candidates = fs.readdirSync(pnpmDir).filter(name => name.startsWith('esbuild@')).sort();
  for (const candidate of candidates) {
    const bin = path.join(pnpmDir, candidate, 'node_modules/esbuild/bin/esbuild');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('esbuild bin not found under node_modules/.pnpm');
}

beforeAll(async () => {
  bundleDir = await createTrackedTempDir('claw-import-reference-fixture-');
  fixtureBundle = path.join(bundleDir, 'claw-import-process-reference-child.mjs');
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
  tempDir = await createTrackedTempDir('claw-import-reference-process-');
  originalRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = tempDir;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  fs.mkdirSync(clawDir(), { recursive: true });
  fs.writeFileSync(path.join(clawDir(), 'config.yaml'), 'name: alice\n');
  fs.mkdirSync(sourceDir());
  fs.writeFileSync(path.join(sourceDir(), 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(sourceDir(), 'b.txt'), 'beta');
});

afterEach(async () => {
  // Precisely terminate only children spawned by this test file, never by name/pattern.
  const remaining = [...liveChildren];
  for (const handle of remaining) {
    if (handle.proc.exitCode === null && handle.proc.signalCode === null) {
      handle.proc.kill('SIGKILL');
    }
  }
  await Promise.all(remaining.map(handle => handle.done));
  liveChildren.clear();
  logSpy.mockRestore();
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  await cleanupTempDir(tempDir);
});

afterAll(async () => {
  await cleanupTempDir(bundleDir);
});

function startPausedImport(pauseAt: 'initial' | 'manifest'): ChildHandle {
  const barrierDir = path.join(tempDir, `barrier-${pauseAt}`);
  fs.mkdirSync(barrierDir, { recursive: true });
  const scenarioPath = path.join(barrierDir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({
    rootDir: tempDir,
    source: sourceDir(),
    clawName: 'alice',
    destParent: clawspaceDir(),
    claimRel: 'src-bundle/.import-claim',
    barrierDir,
    pauseAt,
  }));
  const proc = spawn(process.execPath, [fixtureBundle, scenarioPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CHESTNUT_ROOT: tempDir, NODE_ENV: 'test' },
  });
  const result: ChildResult = { code: null, signal: null, stdout: '', stderr: '' };
  proc.stdout!.on('data', (data: Buffer) => { result.stdout += data.toString(); });
  proc.stderr!.on('data', (data: Buffer) => { result.stderr += data.toString(); });
  const handle = { proc, barrierDir, result } as ChildHandle;
  handle.done = new Promise<void>(resolve => {
    proc.once('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      liveChildren.delete(handle);
      resolve();
    });
  });
  liveChildren.add(handle);
  return handle;
}

function childDetail(handle: ChildHandle): string {
  return `pid=${handle.proc.pid}; code=${handle.result.code}; signal=${handle.result.signal}\n`
    + `stdout=${handle.result.stdout}\nstderr=${handle.result.stderr}`;
}

async function waitForReady(handle: ChildHandle): Promise<{ pid: number; pauseAt: string }> {
  const readyPath = path.join(handle.barrierDir, 'ready.json');
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    if (fs.existsSync(readyPath)) {
      return JSON.parse(fs.readFileSync(readyPath, 'utf8')) as { pid: number; pauseAt: string };
    }
    if (handle.result.code !== null || handle.result.signal !== null) {
      throw new Error(`import child exited before ready\n${childDetail(handle)}`);
    }
    if (Date.now() >= deadline) throw new Error(`ready barrier timeout\n${childDetail(handle)}`);
    await new Promise<void>(resolve => setTimeout(resolve, WAIT_POLL_MS));
  }
}

async function exitAtBarrier(handle: ChildHandle): Promise<void> {
  fs.writeFileSync(path.join(handle.barrierDir, 'release'), 'release');
  await handle.done;
  expect(handle.result.code, childDetail(handle)).toBe(0);
  expect(handle.result.stdout).not.toContain('IMPORT_PROCESS_REFERENCE|completed');
}

function readEvidence(): EvidenceRecord[] {
  const root = path.join(clawDir(), 'status', 'cli-import-claims');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .map(String)
    .filter(name => /^\d{6}\.json$/.test(path.basename(name)))
    .sort((left, right) => left.localeCompare(right))
    .map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as EvidenceRecord);
}

function attemptRecords(attemptId: string): EvidenceRecord[] {
  return readEvidence().filter(record => record.attemptId === attemptId)
    .sort((left, right) => left.sequence - right.sequence);
}

function attemptIdForRaw(raw: string): string {
  const requests = readEvidence().filter(record =>
    record.kind === 'claim_write_requested' && record.exactRaw === raw);
  expect(requests, JSON.stringify(readEvidence())).toHaveLength(1);
  return requests[0].attemptId;
}

function readV1Claim(raw: string, withManifest: boolean): V1Claim {
  const claim = JSON.parse(raw) as V1Claim;
  const keys = ['createdAt', 'holder', 'schema_version', 'source', 'target', 'token'];
  if (withManifest) keys.push('manifestHash');
  expect(Object.keys(claim).sort()).toEqual(keys.sort());
  expect(claim.schema_version).toBe(1);
  expect(claim).not.toHaveProperty('pid');
  expect(claim).not.toHaveProperty('process_start_time');
  expect(claim.holder.kind).toBe('captured');
  expect(claim.holder.evidence).toBeDefined();
  if (withManifest) expect(claim.manifestHash).toEqual(expect.any(String));
  else expect(claim).not.toHaveProperty('manifestHash');
  return claim;
}

function expectSelfCapture(claim: V1Claim, attemptId: string): void {
  const captures = attemptRecords(attemptId).filter(record => record.kind === 'self_capture');
  expect(captures, JSON.stringify(attemptRecords(attemptId))).toHaveLength(1);
  expect(captures[0].capture).toEqual(claim.holder);
}

function expectClaimWriteRequested(raw: string, attemptId: string): void {
  expect(attemptRecords(attemptId)).toContainEqual(
    expect.objectContaining({ kind: 'claim_write_requested', exactRaw: raw }),
  );
}

describe.skipIf(!supported)('claw import real process references', () => {
  it('live initial claim rejects a competitor; exited initial claim remains unrecoverable without manifest', async () => {
    const child = startPausedImport('initial');
    const ready = await waitForReady(child);
    expect(ready).toEqual({ pid: child.proc.pid, pauseAt: 'initial' });

    const initialRaw = fs.readFileSync(claimPath(), 'utf8');
    const initial = readV1Claim(initialRaw, false);
    const attemptId = attemptIdForRaw(initialRaw);
    expectSelfCapture(initial, attemptId);
    expectClaimWriteRequested(initialRaw, attemptId);
    expect(inspectProcessRef(initial.holder.value).kind).toBe('alive');

    await expect(runParentImport()).rejects.toThrow(/holder is not proven gone/);
    expect(fs.readFileSync(claimPath(), 'utf8')).toBe(initialRaw);
    expect(fs.existsSync(path.join(clawspaceDir(), 'src-bundle', 'a.txt'))).toBe(false);

    await exitAtBarrier(child);
    expect(fs.readFileSync(claimPath(), 'utf8')).toBe(initialRaw);
    expect(inspectProcessRef(initial.holder.value)).toMatchObject({ kind: 'gone', reason: 'absent' });

    // Death alone is insufficient: the initial claim has no persisted payload identity.
    await expect(runParentImport()).rejects.toThrow(/cannot be proven/);
    expect(fs.readFileSync(claimPath(), 'utf8')).toBe(initialRaw);
    expect(fs.existsSync(path.join(clawspaceDir(), 'src-bundle', 'a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(clawspaceDir(), 'src-bundle', 'b.txt'))).toBe(false);
  });

  it('manifest claim retains one capture across both writes and recovers the same payload after child exit', async () => {
    const child = startPausedImport('manifest');
    const ready = await waitForReady(child);
    expect(ready).toEqual({ pid: child.proc.pid, pauseAt: 'manifest' });

    const manifestRaw = fs.readFileSync(claimPath(), 'utf8');
    const manifest = readV1Claim(manifestRaw, true);
    const childAttemptId = attemptIdForRaw(manifestRaw);
    const childRecords = attemptRecords(childAttemptId);
    const requests = childRecords.filter(record => record.kind === 'claim_write_requested');
    expect(requests, JSON.stringify(childRecords)).toHaveLength(2);
    expect(requests[1].exactRaw).toBe(manifestRaw);
    const initialRaw = requests[0].exactRaw;
    expect(initialRaw).toEqual(expect.any(String));
    const initial = readV1Claim(initialRaw!, false);
    expect(manifest.holder).toEqual(initial.holder);
    expect(manifest.token).toBe(initial.token);
    expect(manifest.createdAt).toBe(initial.createdAt);
    expectSelfCapture(initial, childAttemptId);
    expectSelfCapture(manifest, childAttemptId);
    expectClaimWriteRequested(initialRaw!, childAttemptId);
    expectClaimWriteRequested(manifestRaw, childAttemptId);
    expect(inspectProcessRef(manifest.holder.value).kind).toBe('alive');

    await expect(runParentImport()).rejects.toThrow(/holder is not proven gone/);
    expect(fs.readFileSync(claimPath(), 'utf8')).toBe(manifestRaw);
    expect(fs.existsSync(path.join(clawspaceDir(), 'src-bundle', 'a.txt'))).toBe(false);

    await exitAtBarrier(child);
    expect(fs.readFileSync(claimPath(), 'utf8')).toBe(manifestRaw);
    expect(inspectProcessRef(manifest.holder.value)).toMatchObject({ kind: 'gone', reason: 'absent' });

    await runParentImport();
    expect(fs.readFileSync(path.join(clawspaceDir(), 'src-bundle', 'a.txt'), 'utf8')).toBe('alpha');
    expect(fs.readFileSync(path.join(clawspaceDir(), 'src-bundle', 'b.txt'), 'utf8')).toBe('beta');
    expect(fs.existsSync(claimPath())).toBe(false);

    const publication = readEvidence().find(record => record.kind === 'publication_ready');
    expect(publication, JSON.stringify(readEvidence())).toBeDefined();
    expect(publication?.exactRaw).toEqual(expect.any(String));
    const publishedClaim = readV1Claim(publication!.exactRaw!, true);
    expect(publishedClaim.manifestHash).toBe(manifest.manifestHash);
    expectSelfCapture(publishedClaim, publication!.attemptId);
    expect(attemptRecords(publication!.attemptId)).toContainEqual(
      expect.objectContaining({ kind: 'claim_written', exactRaw: publication!.exactRaw! }),
    );
    const committed = attemptRecords(publication!.attemptId)
      .find(record => record.kind === 'committed');
    expect(committed, JSON.stringify(attemptRecords(publication!.attemptId))).toBeDefined();
    expect(committed!.sequence).toBeGreaterThan(publication!.sequence);
  });
});
