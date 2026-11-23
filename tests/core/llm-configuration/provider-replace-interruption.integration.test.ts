import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
  type SharedLLMInput,
} from '../../../src/core/llm-configuration/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const FIXTURE_SRC = path.resolve(process.cwd(), 'tests/fixtures/provider-replace-interruption.ts');
const supported = process.platform === 'darwin' || process.platform === 'linux';
const READY_TIMEOUT_MS = 10_000; // 仅限制 ready 文件握手；提交位置由 fixture 钩子确定。
const READY_POLL_MS = 10;
const FIXTURE_BUILD_TIMEOUT_MS = 60_000; // 仅限制 beforeAll 的 esbuild 编译。
const EXPIRED_LOCK_AGE_MS = 60_000; // 超过生产 30s stale 窗口，避免为回收等待真实 30s。
const deps = { fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }) };

type Mode = 'before-commit' | 'after-commit';
interface ReadyFact {
  pid: number;
  cwd: string;
  mode: Mode;
  revisionAtInterruption: { id: string; revision: number };
  lockRaw: string;
  writeKind?: string;
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
let projectDir: string;
let configPath: string;
const children = new Set<ChildHandle>();

function resolveEsbuildBin(): string {
  const pnpmDir = path.resolve(process.cwd(), 'node_modules/.pnpm');
  const candidates = fs.readdirSync(pnpmDir).filter(name => name.startsWith('esbuild@')).sort();
  for (const candidate of candidates) {
    const bin = path.join(pnpmDir, candidate, 'node_modules/esbuild/bin/esbuild');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('esbuild bin not found under node_modules/.pnpm');
}

function provider(model: string): SharedLLMInput['primary'] {
  return {
    provider_id: 'custom:anthropic',
    api_format: 'anthropic',
    auth_profile: 'api_key',
    api_key: '${PHASE2226_INTERRUPTION_KEY}',
    model,
    label: 'interruption-target',
    base_url: 'https://interruption.example.test',
  };
}

beforeAll(async () => {
  bundleDir = await createTrackedTempDir('provider-replace-fixture-build-');
  fixtureBundle = path.join(bundleDir, 'provider-replace-interruption.mjs');
  execFileSync(resolveEsbuildBin(), [
    FIXTURE_SRC,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    `--outfile=${fixtureBundle}`,
  ], { stdio: 'pipe' });
}, FIXTURE_BUILD_TIMEOUT_MS);

beforeEach(async () => {
  projectDir = await createTrackedTempDir('provider-replace-interruption-');
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
  configPath = getLLMConfigurationPath();
});

afterEach(async () => {
  for (const handle of children) {
    if (handle.proc.exitCode === null && handle.proc.signalCode === null) {
      handle.proc.kill('SIGKILL');
    }
  }
  await Promise.all([...children].map(handle => handle.done));
  children.clear();
  vi.unstubAllEnvs();
  await cleanupTempDir(projectDir);
});

afterAll(async () => {
  await cleanupTempDir(bundleDir);
});

function childDetail(handle: ChildHandle): string {
  return `pid=${handle.proc.pid}; code=${handle.result.code}; signal=${handle.result.signal}\n` +
    `stdout=${handle.result.stdout}\nstderr=${handle.result.stderr}`;
}

function startFixture(mode: Mode): ChildHandle {
  const barrierDir = path.join(projectDir, `barrier-${mode}`);
  fs.mkdirSync(barrierDir, { recursive: true });
  const scenarioPath = path.join(barrierDir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({
    mode,
    barrierDir,
    replacementModel: `interrupted-${mode}`,
  }));
  const proc = spawn(process.execPath, [fixtureBundle, scenarioPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CHESTNUT_ROOT: projectDir, NODE_ENV: 'test' },
  });
  const result: ChildResult = { code: null, signal: null, stdout: '', stderr: '' };
  proc.stdout!.on('data', (data: Buffer) => { result.stdout += data.toString(); });
  proc.stderr!.on('data', (data: Buffer) => { result.stderr += data.toString(); });
  let handle!: ChildHandle;
  const done = new Promise<void>(resolve => {
    proc.once('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      children.delete(handle);
      resolve();
    });
  });
  handle = { proc, result, done };
  children.add(handle);
  return handle;
}

async function waitForReady(handle: ChildHandle, mode: Mode): Promise<ReadyFact> {
  const readyPath = path.join(projectDir, `barrier-${mode}`, 'ready.json');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (fs.existsSync(readyPath)) {
      return JSON.parse(fs.readFileSync(readyPath, 'utf8')) as ReadyFact;
    }
    if (handle.result.code !== null || handle.result.signal !== null) {
      throw new Error(`fixture exited before ready\n${childDetail(handle)}`);
    }
    if (Date.now() >= deadline) throw new Error(`ready barrier timeout\n${childDetail(handle)}`);
    await new Promise<void>(resolve => setTimeout(resolve, READY_POLL_MS));
  }
}

function makeLockStale(lockRaw: string): void {
  const payload = JSON.parse(lockRaw) as Record<string, unknown>;
  fs.writeFileSync(`${configPath}.lock`, JSON.stringify({
    ...payload,
    createdAt: new Date(Date.now() - EXPIRED_LOCK_AGE_MS).toISOString(),
  }));
}

describe.skipIf(!supported)('provider replace process interruption', () => {
  it.each(['before-commit', 'after-commit'] as const)(
    '%s 中断后新实例读取完整文档，残留锁可回收并再次提交',
    async mode => {
      const store = createLLMConfigurationDocumentStore(deps);
      await store.commitExplicitProvider({ kind: 'initialize' }, provider('before'));
      const beforeBytes = fs.readFileSync(configPath, 'utf8');
      const handle = startFixture(mode);
      const ready = await waitForReady(handle, mode);
      await handle.done;

      expect(ready.pid).toBe(handle.proc.pid);
      expect(ready.mode).toBe(mode);
      expect(ready.revisionAtInterruption).toEqual({
        id: mode === 'before-commit' ? '1' : '2',
        revision: mode === 'before-commit' ? 1 : 2,
      });
      expect(handle.result.code).toBeNull();
      expect(handle.result.signal, childDetail(handle)).toBe('SIGKILL');
      expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(ready.lockRaw);
      const restarted = createLLMConfigurationDocumentStore(deps);
      if (mode === 'before-commit') {
        expect(ready.writeKind).toBeUndefined();
        expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeBytes);
        expect(restarted.read()).toMatchObject({ revision: 1, primary: { model: 'before' } });
      } else {
        expect(ready.writeKind).toBe('durable');
        expect(restarted.read()).toMatchObject({
          revision: 2,
          primary: { model: 'interrupted-after-commit' },
        });
      }

      makeLockStale(ready.lockRaw);
      const current = restarted.read();
      const recovered = await restarted.commitExplicitProvider(
        { kind: 'replace', slot: { role: 'primary' } },
        { ...current.primary, model: `recovered-${mode}` },
        current.revision,
      );
      expect(recovered.revision).toEqual({
        id: String(current.revision + 1),
        revision: current.revision + 1,
      });
      expect(createLLMConfigurationDocumentStore(deps).read()).toEqual(recovered.document);
      expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
      expect(fs.existsSync(`${configPath}.lock-observations`)).toBe(true);
      expect(fs.readdirSync(path.dirname(configPath))
        .filter(name => name.startsWith('config.yaml.lock.reclaim-'))).toEqual([]);
    },
  );
});
