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

import { existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

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

export default function globalSetup(): void {
  const cwd = process.cwd();
  const distCli = path.join(cwd, 'dist', 'cli.js');
  const srcDir = path.join(cwd, 'src');

  if (!existsSync(distCli)) {
    runBuild(cwd, 'dist/cli.js missing');
    return;
  }

  let distMtime = 0;
  try {
    distMtime = statSync(distCli).mtimeMs;
  } catch {
    // existsSync said yes but stat failed (race?). Conservative: rebuild.
    runBuild(cwd, 'dist/cli.js stat unreadable');
    return;
  }

  const srcMtime = getMaxMtime(srcDir);
  if (srcMtime > distMtime) {
    runBuild(cwd, 'src newer than dist/cli.js');
  }
}
