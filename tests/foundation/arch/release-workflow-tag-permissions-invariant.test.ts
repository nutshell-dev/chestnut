import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 644: invariant that .github/workflows/release.yml:
 * - declares `on.push.tags: ['v*']` — release fires only on v-prefixed
 *   tag push (not arbitrary commits)
 * - declares `permissions: contents: write` — Github Actions defaults
 *   to read-only; softprops/action-gh-release needs write permission to
 *   create the release artifact
 *
 * Rationale (ML#3 single-source release surface + security baseline):
 * - tag pattern drift → release fires on unintended events (e.g.,
 *   accidental push to a branch named 'v-experiment')
 * - permissions drop → release step fails 403 "Resource not accessible
 *   by integration" on first attempt; only discovered when actually
 *   tagging a release
 *
 * Pairs with phase 643 (runs-on + cache), phase 642 (--frozen-lockfile),
 * phase 625 (action pinning), phase 641 (trigger symmetry — for
 * non-release workflows).
 */
describe('release.yml tag + permissions invariant (phase 644)', () => {
  it('triggers on v* tag push + permissions contents: write', () => {
    const releasePath = path.resolve(
      __dirname,
      '../../../.github/workflows/release.yml',
    );
    expect(fs.existsSync(releasePath)).toBe(true);
    const text = fs.readFileSync(releasePath, 'utf-8');

    // Tag pattern check: must match `tags:` then `- 'v*'` (yaml multi-line)
    expect(text).toMatch(/tags:\s*\n\s*-\s+['"]v\*['"]/);
    // Permission check: contents: write under permissions: block
    expect(text).toMatch(/permissions:\s*\n\s*contents:\s+write/);
  });
});
