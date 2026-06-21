import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 643: invariant that every CI workflow has:
 * - `runs-on: ubuntu-latest` (consistent CI runner)
 * - `setup-node` with `cache: 'pnpm'` (consistent dependency caching)
 *
 * Rationale (ML#3 single-source CI platform + caching):
 * - runs-on drift to macos-latest → CI output not directly comparable to
 *   prod (which targets Linux), wall-time + cost increases
 * - cache drift (or missing) → every CI run reinstalls all deps from
 *   scratch, wall-time explodes
 *
 * Pairs with phase 642 (--frozen-lockfile), phase 641 (trigger symmetry),
 * phase 626 (pnpm version), phase 627 (node vs engines).
 */
describe('CI workflow runs-on + setup-node cache invariant (phase 643)', () => {
  it('every workflow uses ubuntu-latest + setup-node cache=pnpm', () => {
    const wfDir = path.resolve(__dirname, '../../../.github/workflows');
    const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml')).sort();
    expect(files.length).toBeGreaterThan(0);

    const runsOnOffenders: string[] = [];
    const cacheOffenders: string[] = [];
    const runsOnRe = /runs-on:\s+(\S+)/g;
    const setupNodeCacheRe = /uses:\s+actions\/setup-node@v\d+[\s\S]*?cache:\s+['"]?([^'"\s]+)['"]?/g;

    for (const f of files) {
      const text = fs.readFileSync(path.join(wfDir, f), 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = runsOnRe.exec(text)) !== null) {
        if (m[1] !== 'ubuntu-latest') {
          runsOnOffenders.push(`${f}: runs-on=${m[1]}`);
        }
      }
      runsOnRe.lastIndex = 0;
      while ((m = setupNodeCacheRe.exec(text)) !== null) {
        if (m[1] !== 'pnpm') {
          cacheOffenders.push(`${f}: setup-node cache=${m[1]}`);
        }
      }
      setupNodeCacheRe.lastIndex = 0;
    }
    expect(runsOnOffenders).toEqual([]);
    expect(cacheOffenders).toEqual([]);
  });
});
