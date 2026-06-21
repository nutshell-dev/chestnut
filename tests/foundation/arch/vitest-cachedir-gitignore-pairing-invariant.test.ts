import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 645: invariant that vitest's `cacheDir` (in vitest.config.ts) is
 * paired with a matching `.gitignore` entry:
 * - vitest.config.ts contains `cacheDir: '.vitest-cache'`
 * - .gitignore contains `.vitest-cache/`
 *
 * Rationale (ML#9 explicit coupling): vitest cache write location +
 * .gitignore exclude location are an inescapable coupling. Drift breaks
 * invisibly:
 * - vitest cacheDir renamed but .gitignore not → new cache dir gets
 *   committed accidentally, git status persistently dirty
 * - .gitignore drops .vitest-cache/ entry but vitest still writes →
 *   cache enters commits
 * - vitest cacheDir reverts to default node_modules/.vite → multi-
 *   worktree share race (regression of phase 1367 fix)
 *
 * Pairs with phase 622 (.gitignore baseline patterns), phase 611
 * (vitest exclude base patterns), phase 610 (project names).
 */
describe('vitest cacheDir ↔ .gitignore pairing invariant (phase 645)', () => {
  it('vitest.config has cacheDir=.vitest-cache + .gitignore has .vitest-cache/', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const vitestCfg = fs.readFileSync(
      path.join(repoRoot, '.config/vitest.config.ts'),
      'utf-8',
    );
    expect(vitestCfg).toMatch(/cacheDir:\s+['"]\.vitest-cache['"]/);

    const gitignore = fs
      .readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8')
      .split('\n')
      .map(l => l.trim());
    expect(gitignore).toContain('.vitest-cache/');
  });
});
