import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 624: invariant that .githooks/post-merge exists, is owner-executable,
 * runs `pnpm run typecheck` + `pnpm run test:run`, and both script names
 * are defined in package.json scripts.
 *
 * Rationale: post-merge hook is the final safety net — it runs after
 * `git merge` completes and verifies the merged tree before the user
 * proceeds. Drift breaks invisibly:
 * - file deleted → no post-merge verification, broken merges flow into
 *   main without local trip-wire
 * - executable bit lost → git silently skips the hook (no error reported)
 * - referenced script renamed in package.json → hook fails with "Missing
 *   script" but the merge is already recorded
 *
 * Extends phase 623 (CI workflow → package.json script ref) to the
 * git-hook channel.
 */
describe('post-merge hook invariant (phase 624)', () => {
  it('exists + executable + calls typecheck/test:run defined in package.json', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const hookPath = path.join(repoRoot, '.githooks/post-merge');
    expect(fs.existsSync(hookPath)).toBe(true);

    const st = fs.statSync(hookPath);
    expect(st.mode & 0o100).not.toBe(0); // owner-execute

    const text = fs.readFileSync(hookPath, 'utf-8');
    const required = ['pnpm run typecheck', 'pnpm run test:run'];
    const missing = required.filter(r => !text.includes(r));
    expect(missing).toEqual([]);

    const pkgPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const scriptNames = new Set(Object.keys(pkg.scripts));
    expect(scriptNames.has('typecheck')).toBe(true);
    expect(scriptNames.has('test:run')).toBe(true);
  });
});
