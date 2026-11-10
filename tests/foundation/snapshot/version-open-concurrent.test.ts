/**
 * phase 2084 Step B：版本库初始化「完整互斥」回归。
 *
 * 契约：一次 open 的完整初始化写入（.git 初始化 → 归属/独立根/sha1 验证 → 三项本地
 * 配置 → published create-only CAS → HEAD 绑定）必须整体落在同一个 `.version-store-init.lock`
 * 磁盘互斥区内；**所有** open 都必须参与，不得因 `.git` 已可解析而绕过；持锁退出要么
 * 成功，要么 loud 失败且保留现场（不删 .git、不删他人/残留锁）。
 *
 * 覆盖：
 * - 确定性屏障：A 持锁停在首次 config 写前，B 收到 EEXIST 且未进入任何初始化写区；
 *   放行后两者成功且 config/HEAD/published 一致；已有 .git 但配置待修同样不得绕过锁。
 * - 失败矩阵：A 失败后 B 可继续；等待超时不删持有者锁（可控时钟，不用真实 10s sleep）；
 *   损坏 .git 保留现场；释放单独失败拒绝成功；初始化+释放双失败 cause 含两者；
 *   取锁非 EEXIST 原错误保全；不同库不互相等待；已有完整库重复 open 保持 published 身份。
 * - 跨进程 smoke：两个独立进程（esbuild 临时 bundle + spawn + IPC）同库 createVersionStore。
 *
 * 屏障只用 promise/事件构造，不用固定 sleep 猜到达点；bounded wait 仅防挂死。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { exec as defaultExec } from '../../../src/foundation/process-exec/index.js';
import { createVersionStore, VersionStoreError } from '../../../src/foundation/snapshot/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const INIT_LOCK = '.version-store-init.lock';

/** bounded wait 上限：只用于防挂死，不参与时序构造 */
const BOUNDED_WAIT_MS = 30_000;

const gitAvailable = (() => {
  try { execFileSync('which', ['git'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * 生产 gitExec 在归属验证后会给参数加 `--git-dir <dir>` 前缀，因此屏障点按包含关系
 * 识别“首次写 user.name=chestnut”（只写这一对 key/value，不会误命中 `--get` 读取）。
 */
function isConfigWriteOf(args: string[], key: string, value: string): boolean {
  return args.includes('config') && args.includes(key) && args.includes(value);
}

/** 归属验证后 gitExec 会给参数加 `--git-dir <dir>` 前缀 → 按包含关系识别 symbolic-ref */
const failSymbolicRef = (args: string[]): { exitCode: number; output: string } | undefined =>
  args.includes('symbolic-ref') ? { exitCode: 1, output: 'symbolic-ref boom' } : undefined;

/* ---------- exec 注入缝（只观测/暂停，其余原样转发生产 exec） ---------- */

interface ExecHook {
  /** 调用前钩子：可在此暂停（屏障）——必须返回 promise 才可阻塞 */
  before?: (args: string[]) => Promise<void> | void;
  onCall?: (args: string[]) => void;
  /** 返回非 undefined 时模拟该 git 调用以给定 exit code 失败 */
  fail?: (args: string[]) => { exitCode: number; output: string } | undefined;
}

function hookedExec(hook: ExecHook): typeof defaultExec {
  return async (command, args, options) => {
    hook.onCall?.(args);
    await hook.before?.(args);
    const failure = hook.fail?.(args);
    if (failure !== undefined) {
      // 与 Node child_process 失败形态一致：gitExec 依据 exitCode 归类为 ok:false
      throw Object.assign(new Error(failure.output), { exitCode: failure.exitCode, output: failure.output });
    }
    return defaultExec(command, args, options);
  };
}

/* ---------- fs 注入缝（只包 init 锁相关调用；其余委托真实 NodeFileSystem） ---------- */

interface FsHooks {
  onLockAttempt?: (attempt: number) => void;
  onLockAcquired?: () => void;
  onLockEexist?: (attempt: number) => void;
  /** 返回非 undefined 时模拟取锁失败（例如非 EEXIST 的 EACCES） */
  lockAcquireError?: () => Error | undefined;
  /** 返回非 undefined 时模拟释放失败 */
  lockReleaseError?: () => Error | undefined;
}

interface FsControl {
  fs: FileSystem;
  lockAttempts: () => number;
  lockAcquisitions: () => number;
  eexistCount: () => number;
  releaseAttempts: () => number;
}

function controlledFs(baseDir: string, hooks: FsHooks = {}): FsControl {
  const inner = new NodeFileSystem({ baseDir });
  let attempts = 0;
  let acquisitions = 0;
  let eexists = 0;
  let releases = 0;
  const fs = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'writeExclusive') {
        return async (rel: string, content: string): Promise<void> => {
          if (rel === INIT_LOCK) {
            attempts += 1;
            hooks.onLockAttempt?.(attempts);
            const injected = hooks.lockAcquireError?.();
            if (injected !== undefined) throw injected;
          }
          try {
            await target.writeExclusive(rel, content);
          } catch (error) {
            if (rel === INIT_LOCK && (error as NodeJS.ErrnoException)?.code === 'EEXIST') {
              eexists += 1;
              hooks.onLockEexist?.(eexists);
            }
            throw error;
          }
          if (rel === INIT_LOCK) {
            acquisitions += 1;
            hooks.onLockAcquired?.();
          }
        };
      }
      if (prop === 'delete') {
        return async (rel: string): Promise<void> => {
          if (rel === INIT_LOCK) {
            releases += 1;
            const injected = hooks.lockReleaseError?.();
            if (injected !== undefined) throw injected;
          }
          return target.delete(rel);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as FileSystem;
  return {
    fs,
    lockAttempts: () => attempts,
    lockAcquisitions: () => acquisitions,
    eexistCount: () => eexists,
    releaseAttempts: () => releases,
  };
}

/* ---------- 跨进程 smoke 基础设施（esbuild 临时 bundle + spawn + IPC） ---------- */

const FIXTURE_SRC = path.resolve(process.cwd(), 'tests/foundation/snapshot/fixtures/version-open-child.ts');

/** 定位 pnpm 隔离布局下的 esbuild bin（tsup 的传递依赖，不新增直接依赖）。 */
function resolveEsbuildBin(): string {
  const pnpmDir = path.resolve(process.cwd(), 'node_modules/.pnpm');
  const hit = fsSync
    .readdirSync(pnpmDir)
    .filter((d) => d.startsWith('esbuild@'))
    .sort();
  for (const d of hit) {
    const bin = path.join(pnpmDir, d, 'node_modules/esbuild/bin/esbuild');
    if (fsSync.existsSync(bin)) return bin;
  }
  throw new Error('esbuild bin not found under node_modules/.pnpm');
}

interface WorkerMessage { type: string; pid?: number; kind?: string; message?: string }

interface WorkerHandle {
  proc: ChildProcess;
  messages: WorkerMessage[];
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  send: (message: WorkerMessage) => void;
  waitFor: (type: string, timeoutMs?: number) => Promise<WorkerMessage>;
  diagnostics: () => string;
}

const liveChildren = new Set<ChildProcess>();
let fixtureBundleDir: string;
let fixtureBundle: string;

beforeAll(async () => {
  fixtureBundleDir = await createTrackedTempDir('version-open-fixture-build-');
  fixtureBundle = path.join(fixtureBundleDir, 'version-open-child.mjs');
  execFileSync(
    resolveEsbuildBin(),
    [FIXTURE_SRC, '--bundle', '--platform=node', '--format=esm', '--target=node20', `--outfile=${fixtureBundle}`],
    { stdio: 'pipe' },
  );
}, 60_000);

afterAll(async () => {
  await cleanupTempDir(fixtureBundleDir);
});

describe.skipIf(!gitAvailable)('version-store 完整初始化互斥（phase 2084 Step B）', () => {
  let tmpDir: string;

  const repositoryDir = (): string => path.join(tmpDir, 'repo');
  const repositoryDirN = (n: number): string => path.join(tmpDir, `repo-${n}`);
  const workspaceParent = (): string => path.join(tmpDir, 'ws-parent');
  const initLockPath = (dir = repositoryDir()): string => path.join(dir, INIT_LOCK);

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('version-store-init-lock-');
  });

  afterEach(async () => {
    // 先确保遗留 child 进程 close（stdio/IPC 已 flush），再清临时目录
    for (const child of liveChildren) {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
    await Promise.all([...liveChildren].map((child) => new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      setTimeout(resolve, 5_000);
    })));
    liveChildren.clear();
    await cleanupTempDir(tmpDir);
  });

  function spawnWorker(mode: 'initiator' | 'follower', dir: string): WorkerHandle {
    const proc = spawn(process.execPath, [fixtureBundle, mode, dir, workspaceParent()], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    liveChildren.add(proc);
    const messages: WorkerMessage[] = [];
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const pending = new Map<string, (m: WorkerMessage) => void>();
    proc.on('message', (raw: unknown) => {
      const message = raw as WorkerMessage;
      messages.push(message);
      const waiter = pending.get(message.type);
      if (waiter !== undefined) {
        pending.delete(message.type);
        waiter(message);
      }
    });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.on('close', (code, signal) => {
        liveChildren.delete(proc);
        resolve({ code, signal });
      });
    });
    return {
      proc,
      messages,
      done,
      send: (message) => { proc.send?.(message); },
      waitFor: (type, timeoutMs = BOUNDED_WAIT_MS) => {
        const hit = messages.find((m) => m.type === type);
        if (hit !== undefined) return Promise.resolve(hit);
        return new Promise<WorkerMessage>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(type);
            reject(new Error(`worker message timeout: ${type}; messages=${JSON.stringify(messages)}; stderr=${stderr}`));
          }, timeoutMs);
          pending.set(type, (m) => { clearTimeout(timer); resolve(m); });
        });
      },
      diagnostics: () => `stdout=${stdout}\nstderr=${stderr}\nmessages=${JSON.stringify(messages)}`,
    };
  }

  /** 断言库终态：三项配置、HEAD 绑定、published 指向单个空提交 */
  function expectConsistentRepo(dir: string): void {
    expect(git(dir, 'config', 'user.name')).toBe('chestnut');
    expect(git(dir, 'config', 'user.email')).toBe('chestnut@local');
    expect(git(dir, 'config', 'chestnut.versionstore')).toBe('1918');
    expect(git(dir, 'symbolic-ref', 'HEAD')).toBe('refs/version/published');
    const published = git(dir, 'rev-parse', 'refs/version/published');
    expect(git(dir, 'cat-file', '-t', published)).toBe('commit');
    expect(git(dir, 'rev-list', '--count', published)).toBe('1');
    expect(fsSync.existsSync(path.join(dir, INIT_LOCK))).toBe(false);
  }

  /* ---------------- 屏障：完整初始化写入在同一个互斥区内 ---------------- */

  it('屏障：A 持锁停在首次 config 写前，B 收到 EEXIST 且未进入初始化写区，放行后两者成功且终态一致', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });

    const entered = deferred();
    const releaseA = deferred();
    const aAudit = makeAudit();
    const aPromise = createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: new NodeFileSystem({ baseDir: dir }),
      audit: aAudit.audit,
      exec: hookedExec({
        before: async (args) => {
          // 首次 config 写入（此前已有 config --get 读取）发生在初始化写区中段
          if (isConfigWriteOf(args, 'user.name', 'chestnut')) {
            entered.resolve();
            await releaseA.promise;
          }
        },
      }),
    });
    await entered.promise;
    expect(fsSync.existsSync(initLockPath())).toBe(true);

    const bWriteCalls: string[][] = [];
    const bEexist = deferred();
    const bControl = controlledFs(dir, { onLockEexist: () => bEexist.resolve() });
    const bAudit = makeAudit();
    const bPromise = createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: bControl.fs,
      audit: bAudit.audit,
      exec: hookedExec({ onCall: (args) => bWriteCalls.push(args) }),
    });

    // 旧实现会因 .git 已可解析而绕过锁并直接完成初始化 → 先拿到 'b-finished'
    const reached = await Promise.race([
      bEexist.promise.then(() => 'eexist' as const),
      bPromise.then(() => 'b-finished' as const, () => 'b-failed' as const),
    ]);
    expect(reached).toBe('eexist');
    // B 在锁外的尝试没有执行任何 git 调用：没有 config / published / HEAD 写入
    expect(bWriteCalls).toEqual([]);
    // A 仍持锁：B 只是等待，锁文件未被删/接管
    expect(fsSync.existsSync(initLockPath())).toBe(true);

    releaseA.resolve();
    const [aOpened, bOpened] = await Promise.all([aPromise, bPromise]);
    expect(aOpened).toBeDefined();
    expect(bOpened).toBeDefined();
    expectConsistentRepo(dir);
    expect(bControl.lockAcquisitions()).toBe(1);
  }, BOUNDED_WAIT_MS);

  it('屏障：已存在 .git 但配置待修时，B 同样不得绕过锁（readiness 探针不能放行）', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });
    // 真实 git init：probe 可通过；本地身份是陈旧值 → 需要修复
    git(dir, 'init');
    git(dir, 'config', 'user.name', 'stale-name');

    const entered = deferred();
    const releaseA = deferred();
    const aPromise = createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: new NodeFileSystem({ baseDir: dir }),
      audit: makeAudit().audit,
      exec: hookedExec({
        before: async (args) => {
          if (isConfigWriteOf(args, 'user.name', 'chestnut')) {
            entered.resolve();
            await releaseA.promise;
          }
        },
      }),
    });
    await entered.promise;

    const bWriteCalls: string[][] = [];
    const bEexist = deferred();
    const bControl = controlledFs(dir, { onLockEexist: () => bEexist.resolve() });
    const bPromise = createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: bControl.fs,
      audit: makeAudit().audit,
      exec: hookedExec({ onCall: (args) => bWriteCalls.push(args) }),
    });
    const reached = await Promise.race([
      bEexist.promise.then(() => 'eexist' as const),
      bPromise.then(() => 'b-finished' as const, () => 'b-failed' as const),
    ]);
    expect(reached).toBe('eexist');
    expect(bWriteCalls).toEqual([]);
    expect(git(dir, 'config', 'user.name')).toBe('stale-name');

    releaseA.resolve();
    await Promise.all([aPromise, bPromise]);
    expectConsistentRepo(dir);
  }, BOUNDED_WAIT_MS);

  it('已有完整库重复 open 仍取锁，published 身份与 HEAD 不变', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });
    await createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: new NodeFileSystem({ baseDir: dir }),
      audit: makeAudit().audit,
    });
    const published = git(dir, 'rev-parse', 'refs/version/published');

    const control = controlledFs(dir);
    await createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: control.fs,
      audit: makeAudit().audit,
    });

    expect(control.lockAcquisitions()).toBe(1);
    expect(control.eexistCount()).toBe(0);
    expect(git(dir, 'rev-parse', 'refs/version/published')).toBe(published);
    expectConsistentRepo(dir);
  }, BOUNDED_WAIT_MS);

  /* ---------------- 失败矩阵 ---------------- */

  it('失败保全：A 初始化失败后释放自己的锁，B 可继续完成初始化', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });

    const aErr = await createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: new NodeFileSystem({ baseDir: dir }),
      audit: makeAudit().audit,
      exec: hookedExec({ fail: failSymbolicRef }),
    }).catch((e: unknown) => e);
    expect(aErr).toBeInstanceOf(VersionStoreError);
    expect((aErr as VersionStoreError).kind).toBe('git_error');
    // A 释放了自己取得的锁；.git 现场保留（不删除）
    expect(fsSync.existsSync(initLockPath())).toBe(false);
    expect(fsSync.existsSync(path.join(dir, '.git'))).toBe(true);

    await createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: new NodeFileSystem({ baseDir: dir }),
      audit: makeAudit().audit,
    });
    expectConsistentRepo(dir);
  }, BOUNDED_WAIT_MS);

  it('等待超时：有界失败、不删持有者锁、审计只记一次（可控时钟，不用真实 10s sleep）', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });
    // 模拟另一个存活持有者留下的锁
    fsSync.writeFileSync(initLockPath(dir), '4242');

    vi.useFakeTimers();
    try {
      const audit = makeAudit();
      const control = controlledFs(dir, {
        lockAcquireError: () => Object.assign(new Error('lock held'), { code: 'EEXIST' }),
      });
      let outcome: unknown;
      let state: 'pending' | 'opened' | 'failed' = 'pending';
      const openPromise = createVersionStore({
        repositoryDir: dir,
        workspaceParent: workspaceParent(),
        fs: control.fs,
        audit: audit.audit,
      }).then(
        () => { state = 'opened'; return 'opened' as const; },
        (e: unknown) => { outcome = e; state = 'failed'; return 'failed' as const; },
      );
      // 逐 20ms 推进可控时钟直到 settle（上限 700 步 > 10s/20ms），不依赖真实时间
      for (let i = 0; i < 700 && state === 'pending'; i += 1) {
        await vi.advanceTimersByTimeAsync(20);
      }
      const result = await openPromise;
      expect(result).toBe('failed');
      expect(outcome).toBeInstanceOf(VersionStoreError);
      expect((outcome as VersionStoreError).kind).toBe('repo_init_failed');
      expect((outcome as VersionStoreError).message).toMatch(/timed out/);
      // 最后一次 EEXIST 作为 cause 保留
      expect((((outcome as VersionStoreError).cause) as NodeJS.ErrnoException | undefined)?.code).toBe('EEXIST');
      // 未误删持有者的锁、内容未变
      expect(fsSync.readFileSync(initLockPath(dir), 'utf8')).toBe('4242');
      // 有界重试（> 1 次）且没有进入任何 git 写区（.git 未被创建）
      expect(control.lockAttempts()).toBeGreaterThan(1);
      expect(fsSync.existsSync(path.join(dir, '.git'))).toBe(false);
      // 超时只记一条审计
      const initFailed = audit.events.filter(([type]) => type === 'snapshot_version_init_failed');
      expect(initFailed).toHaveLength(1);
      expect(initFailed[0]!.join(' ')).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  }, BOUNDED_WAIT_MS);

  it('反向：损坏 .git 保留现场，本次失败仍释放自己取得的锁', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fsSync.writeFileSync(path.join(dir, '.git', ' garbage'), 'junk');
    const audit = makeAudit();

    const err = await createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: new NodeFileSystem({ baseDir: dir }),
      audit: audit.audit,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionStoreError);
    expect((err as VersionStoreError).kind).toBe('repo_invalid');
    // 现场保留：损坏的 .git 内容原样在场
    expect(fsSync.readFileSync(path.join(dir, '.git', ' garbage'), 'utf8')).toBe('junk');
    // 本次已取得的锁必须释放（否则好库也会被自己的失败锁死）
    expect(fsSync.existsSync(initLockPath(dir))).toBe(false);
    expect(audit.events.some(([type, , kind]) => type === 'snapshot_version_init_failed' && kind === 'kind=repo_invalid')).toBe(true);
  }, BOUNDED_WAIT_MS);

  it('失败保全：释放单独失败时拒绝成功，cause 为释放错误且锁现场保留', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });
    const releaseError = Object.assign(new Error('delete failed'), { code: 'EIO' });
    const audit = makeAudit();
    const control = controlledFs(dir, { lockReleaseError: () => releaseError });

    const err = await createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: control.fs,
      audit: audit.audit,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionStoreError);
    expect((err as VersionStoreError).kind).toBe('repo_init_failed');
    expect((err as VersionStoreError).message).toMatch(/lock release failed/);
    expect((err as VersionStoreError).cause).toBe(releaseError);
    // 初始化本身已完成（库可用），但 open 绝不报成功
    expect(git(dir, 'rev-parse', 'refs/version/published')).toBeTruthy();
    expect(control.releaseAttempts()).toBe(1);
    // 锁现场保留（不猜测他人/残留锁）
    expect(fsSync.existsSync(initLockPath(dir))).toBe(true);
    const initFailed = audit.events.filter(([type]) => type === 'snapshot_version_init_failed');
    expect(initFailed).toHaveLength(1);
    // 审计原因保留原释放错误全文（formatErr(cause)），不是只有一句结论
    expect(initFailed[0]!.join(' ')).toMatch(/release failed/);
    expect(initFailed[0]!.join(' ')).toMatch(/delete failed/);
  }, BOUNDED_WAIT_MS);

  it('信息不丢失：初始化与释放双失败时 cause 为 AggregateError 且保留两者', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });
    const releaseError = Object.assign(new Error('delete failed'), { code: 'EIO' });
    const control = controlledFs(dir, { lockReleaseError: () => releaseError });

    const err = await createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: control.fs,
      audit: makeAudit().audit,
      exec: hookedExec({ fail: failSymbolicRef }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionStoreError);
    expect((err as VersionStoreError).kind).toBe('repo_init_failed');
    const cause = (err as VersionStoreError).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    const errors = (cause as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(VersionStoreError);
    expect((errors[0] as VersionStoreError).kind).toBe('git_error');
    expect(errors[1]).toBe(releaseError);
  }, BOUNDED_WAIT_MS);

  it('取锁非 EEXIST 错误：立即失败并保留原错误为 cause，不进入 git 初始化', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });
    const acquireError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const control = controlledFs(dir, { lockAcquireError: () => acquireError });

    const err = await createVersionStore({
      repositoryDir: dir,
      workspaceParent: workspaceParent(),
      fs: control.fs,
      audit: makeAudit().audit,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionStoreError);
    expect((err as VersionStoreError).kind).toBe('repo_init_failed');
    expect((err as VersionStoreError).cause).toBe(acquireError);
    expect(control.lockAttempts()).toBe(1);
    expect(fsSync.existsSync(path.join(dir, '.git'))).toBe(false);
  }, BOUNDED_WAIT_MS);

  it('不同库不互相等待：repo1 持锁暂停时 repo2 正常完成', async () => {
    const dir1 = repositoryDirN(1);
    const dir2 = repositoryDirN(2);
    fsSync.mkdirSync(dir1, { recursive: true });
    fsSync.mkdirSync(dir2, { recursive: true });

    const entered = deferred();
    const releaseA = deferred();
    const aPromise = createVersionStore({
      repositoryDir: dir1,
      workspaceParent: workspaceParent(),
      fs: new NodeFileSystem({ baseDir: dir1 }),
      audit: makeAudit().audit,
      exec: hookedExec({
        before: async (args) => {
          if (isConfigWriteOf(args, 'user.name', 'chestnut')) {
            entered.resolve();
            await releaseA.promise;
          }
        },
      }),
    });
    await entered.promise;

    await createVersionStore({
      repositoryDir: dir2,
      workspaceParent: workspaceParent(),
      fs: new NodeFileSystem({ baseDir: dir2 }),
      audit: makeAudit().audit,
    });
    expectConsistentRepo(dir2);

    releaseA.resolve();
    await aPromise;
    expectConsistentRepo(dir1);
  }, BOUNDED_WAIT_MS);

  /* ---------------- 真实跨进程 smoke ---------------- */

  it('跨进程 smoke：两个独立进程同库 createVersionStore 串行完成', async () => {
    const dir = repositoryDir();
    fsSync.mkdirSync(dir, { recursive: true });
    const initiator = spawnWorker('initiator', dir);
    let follower: WorkerHandle | undefined;
    try {
      // A 已持有磁盘锁并停在首次 config 写之前（屏障点在初始化写区中段）
      await initiator.waitFor('entered');
      expect(fsSync.existsSync(initLockPath(dir))).toBe(true);

      // A 持锁期间才启动 B：B 必须观察到磁盘锁竞争（EEXIST）而不是直接进入写区
      follower = spawnWorker('follower', dir);
      const followerHandle = follower;
      const contention = await Promise.race([
        followerHandle.waitFor('lock-busy').then(() => 'busy' as const, () => 'timeout' as const),
        followerHandle.done.then(() => 'exited' as const),
      ]);
      expect(contention, `follower 未观察到锁竞争；${followerHandle.diagnostics()}`).toBe('busy');

      initiator.send({ type: 'release' });
      const [aExit, bExit] = await Promise.all([initiator.done, followerHandle.done]);
      expect(aExit.code, `initiator 退出异常；${initiator.diagnostics()}`).toBe(0);
      expect(bExit.code, `follower 退出异常；${followerHandle.diagnostics()}`).toBe(0);
      expect(initiator.messages.filter((m) => m.type === 'error')).toEqual([]);
      expect(followerHandle.messages.filter((m) => m.type === 'error')).toEqual([]);
      expect(initiator.messages.some((m) => m.type === 'ok')).toBe(true);
      expect(followerHandle.messages.some((m) => m.type === 'ok')).toBe(true);

      expectConsistentRepo(dir);
    } finally {
      // 释放屏障 + 等子进程退出（afterEach 再兜底 kill/清理）
      for (const handle of [initiator, follower]) {
        if (handle !== undefined && handle.proc.exitCode === null && handle.proc.signalCode === null) {
          try { handle.send({ type: 'release' }); } catch { /* ignore */ }
        }
      }
      const exits: Array<Promise<unknown>> = [initiator.done];
      if (follower !== undefined) exits.push(follower.done);
      await Promise.all(exits);
    }
  }, 60_000);
});
