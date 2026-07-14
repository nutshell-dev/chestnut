/**
 * vitest globalSetup — auto-build dist/cli.js if missing or stale (phase 245 + 248).
 *
 * Background: a small number of CLI smoke tests
 * (tests/cli/parseint-nan-guard-smoke.test.ts +
 *  tests/cli/program-top-level-help-claw-term.test.ts)
 * spawn the built CLI subprocess at runtime. They guard against the
 * worktree-with-no-dist state with `if (!existsSync(CLI_ENTRY)) throw`,
 * which previously surfaced as stable failures after `git worktree add`
 * until the developer manually ran `pnpm build`.
 *
 * Two failure modes are now covered:
 * - Missing dist (phase 245): `existsSync(distCli)` false → build.
 * - Stale dist (phase 248): any src tree mtime > dist/cli.js mtime → build.
 *
 * The staleness check walks src/ once per vitest invocation (~50-150ms on
 * APFS for ~500 files) and triggers a rebuild when the developer has edited
 * source after the last build. This prevents the "I edited the CLI but
 * forgot to rebuild and the smoke tests still pass against the old binary"
 * false-success class.
 *
 * Known limits (documented, intentionally):
 * - Non-.ts assets (templates / skills copied via `pnpm run copy-templates`
 *   + `pnpm run copy-skills`) live under src/templates and src/skills —
 *   they are walked as part of src/, so changes under those subdirectories
 *   also trigger rebuild.
 * - `git checkout` between branches may leave src mtime older than dist
 *   even though the actual content differs. We do not attempt to detect
 *   this; the developer is responsible for `pnpm build` after a branch
 *   switch that crosses CLI changes.
 * - The walker uses try/catch around each fs op; any unexpected error
 *   falls through to a conservative build to avoid spurious test failures.
 */

import { existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

// 在重定向 TMPDIR 前保存真实系统 tmpdir，供 teardown/reclaim 使用
const HOST_TMPDIR = os.tmpdir();

function getMaxMtime(dir: string): number {
  let max = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          const sub = getMaxMtime(full);
          if (sub > max) max = sub;
        } else if (entry.isFile()) {
          const m = statSync(full).mtimeMs;
          if (m > max) max = m;
        }
      } catch {
        // silent: per-entry failures (broken symlink, race with editor swap) — skip the entry,
        // let the rest of the walk decide. Worst case: we miss one file's mtime; if it was the
        // newest, we miss a needed rebuild, and the smoke test would catch the divergence.
      }
    }
  } catch {
    // silent: dir-level failures — treat as "no useful signal" and let caller fall through to build
  }
  return max;
}

function runBuild(cwd: string, reason: string): void {
  process.stderr.write(`[vitest-globalSetup] ${reason} — running pnpm build...\n`);
  const r = spawnSync('pnpm', ['run', 'build'], { stdio: 'inherit', cwd });
  if (r.status !== 0) {
    throw new Error(
      `[vitest-globalSetup] pnpm build failed (exit ${r.status}); CLI smoke tests will fail without a current dist/cli.js`,
    );
  }
}

const RUN_ROOT_PREFIX = 'chestnut-run-';
const STALE_AGE_MS = 10 * 60 * 1000; // 10 minutes

export interface RunManifest {
  invocationId: string;
  pid: number;
  worktree: string;
  startedAt: string;
  runRoot: string;
}

function createRunRoot(): RunManifest {
  const invocationId = randomUUID();
  // 始终在真实系统 tmpdir 下创建 run root（此时 TMPDIR 尚未被重定向）
  const runRoot = path.join(HOST_TMPDIR, `${RUN_ROOT_PREFIX}${invocationId}`);
  fs.mkdirSync(runRoot, { recursive: true });

  const manifest: RunManifest = {
    invocationId,
    pid: process.pid,
    worktree: process.cwd(),
    startedAt: new Date().toISOString(),
    runRoot,
  };

  fs.writeFileSync(
    path.join(runRoot, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  // 写入环境变量供 worker 读取
  process.env.CHESTNUT_RUN_ROOT = runRoot;
  process.env.CHESTNUT_INVOCATION_ID = invocationId;
  process.env.CHESTNUT_HOST_TMPDIR = HOST_TMPDIR;

  // 回收过期运行目录（owner 已失效的）
  reclaimStaleRunRoots(HOST_TMPDIR, invocationId);

  return manifest;
}

function reclaimStaleRunRoots(hostTmpdir: string, currentInvocationId: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(hostTmpdir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_ROOT_PREFIX)) continue;

    const runPath = path.join(hostTmpdir, entry.name);
    const manifestPath = path.join(runPath, 'manifest.json');

    let manifest: RunManifest | null = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      // 无 manifest 或损坏 → 安全跳过（不删未知目录）
      continue;
    }

    // 不回收当前 invocation
    if (manifest.invocationId === currentInvocationId) continue;

    // 核 owner 是否存活 + 过期
    if (isOwnerAlive(manifest) || !isRunRootStale(runPath)) continue;

    // 回收
    try {
      rmSync(runPath, { recursive: true, force: true });
      process.stderr.write(`[vitest-globalSetup] reclaimed stale run root: ${runPath}\n`);
    } catch (err) {
      process.stderr.write(`[vitest-globalSetup] failed to reclaim ${runPath}: ${err}\n`);
    }
  }
}

// phase 1011: cache git worktree list so reclaimStaleRunRoots only shells out once per invocation.
// phase 1013: distinguish "git command failed" from "git succeeded but worktree not registered".
type WorktreeResult = { ok: true; paths: Set<string> } | { ok: false };

let registeredWorktrees: WorktreeResult | null = null;

function getRegisteredWorktrees(): WorktreeResult {
  if (registeredWorktrees) return registeredWorktrees;
  try {
    const list = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      timeout: 2000,
    });
    const paths = new Set<string>();
    for (const line of list.split('\n')) {
      if (line.startsWith('worktree ')) {
        paths.add(line.slice('worktree '.length));
      }
    }
    registeredWorktrees = { ok: true, paths };
  } catch {
    // git 命令失败 → isOwnerAlive 会 fall back 到目录存在检查
    registeredWorktrees = { ok: false };
  }
  return registeredWorktrees;
}

function isOwnerAlive(manifest: RunManifest): boolean {
  // 1. PID 存活检查
  try {
    process.kill(manifest.pid, 0); // signal 0 = 只检查不发送
  } catch {
    return false; // ESRCH: PID 不存在
  }

  // 2. worktree 是否仍被当前 git 仓库注册
  // phase 1008: 用 git worktree list 判断路径是否仍注册，避免主仓库目录永远存在导致 PID 复用时误认存活。
  // phase 1011: 缓存结果，避免每个 run root 都执行一次 git worktree list。
  // phase 1013: Git 失败才 fall back 到 statSync；Git 成功且未注册 → 明确判定 owner dead。
  const wts = getRegisteredWorktrees();
  if (wts.ok) {
    return wts.paths.has(manifest.worktree); // 注册 → alive；未注册 → dead
  }

  // git 命令失败 → 保守：目录存在即认为可能存活
  try {
    if (fs.statSync(manifest.worktree).isDirectory()) return true;
  } catch { /* fall through */ }

  return false;
}

function isRunRootStale(runPath: string): boolean {
  try {
    const stats = fs.statSync(runPath);
    return Date.now() - stats.mtimeMs > STALE_AGE_MS;
  } catch {
    return false;
  }
}

export default function globalSetup(): () => Promise<void> {
  // 先创建运行根目录，让 worker 在测试运行期间可读取 CHESTNUT_RUN_ROOT
  const manifest = createRunRoot();

  // TMPDIR 重定向——让 worker 内的 os.tmpdir() 返回 run root
  process.env.TMPDIR = manifest.runRoot;
  process.env.TMP = manifest.runRoot;
  process.env.TEMP = manifest.runRoot;

  const cwd = process.cwd();
  const distCli = path.join(cwd, 'dist', 'cli.js');
  const srcDir = path.join(cwd, 'src');

  if (!existsSync(distCli)) {
    runBuild(cwd, 'dist/cli.js missing');
  } else {
    let distMtime = 0;
    try {
      distMtime = statSync(distCli).mtimeMs;
    } catch {
      // existsSync said yes but stat failed (race?). Conservative: rebuild.
      runBuild(cwd, 'dist/cli.js stat unreadable');
    }

    const srcMtime = getMaxMtime(srcDir);
    if (srcMtime > distMtime) {
      runBuild(cwd, 'src newer than dist/cli.js');
    }
  }

  // 返回 teardown 函数，在 invocation 结束时清理 run root
  return async function teardown() {
    const keep = process.env.CHESTNUT_KEEP_TEST_TMP === '1';
    if (keep) {
      console.warn(`[vitest-teardown] CHESTNUT_KEEP_TEST_TMP=1, preserving run root: ${manifest.runRoot}`);
      return;
    }
    try {
      await fs.promises.rm(manifest.runRoot, { recursive: true, force: true });
    } catch (err) {
      // teardown 失败必须让 invocation 失败
      throw new Error(
        `[vitest-teardown] Failed to remove run root ${manifest.runRoot}: ${err}`,
        { cause: err },
      );
    }
  };
}
