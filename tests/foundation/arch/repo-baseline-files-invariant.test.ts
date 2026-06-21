import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 639: invariant that 3 repo baseline files exist + are well-formed:
 * - LICENSE              — MIT text (package.json declares license=MIT,
 *                          must be backed by an actual LICENSE file or
 *                          users have no legal certainty)
 * - pnpm-lock.yaml       — pnpm lockfile (CI runs `pnpm install
 *                          --frozen-lockfile`; missing → CI installs
 *                          latest versions → non-reproducible)
 * - .gitattributes       — must contain `.config/dependency-cruiser.cjs
 *                          merge=union` line (multi-branch adds to
 *                          dependency-cruiser.cjs rely on union merge to
 *                          avoid manual conflict resolution)
 *
 * Rationale: each missing file has a distinct failure mode — license
 * ambiguity, non-reproducible CI, merge conflict storms during parallel
 * rule additions. Security/hygiene baselines, not optional optimizations.
 *
 * Pairs with phase 622 (.gitignore baseline), phase 621 (package
 * identity), phase 626 (CI pnpm version consistency).
 */
describe('repo baseline files invariant (phase 639)', () => {
  it('LICENSE + pnpm-lock.yaml exist + .gitattributes has dependency-cruiser union merge', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    expect(fs.existsSync(path.join(repoRoot, 'LICENSE'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))).toBe(true);

    const gitattributesPath = path.join(repoRoot, '.gitattributes');
    expect(fs.existsSync(gitattributesPath)).toBe(true);
    const text = fs.readFileSync(gitattributesPath, 'utf-8');
    expect(text).toContain('.config/dependency-cruiser.cjs merge=union');
  });
});
