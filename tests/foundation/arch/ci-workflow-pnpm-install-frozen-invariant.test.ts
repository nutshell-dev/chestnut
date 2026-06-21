import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 642: invariant that every `pnpm install` invocation in
 * .github/workflows/*.yml includes the `--frozen-lockfile` flag.
 *
 * Rationale (ML#3 reproducibility baseline): CI must bind to the
 * lockfile (frozen). Without --frozen-lockfile pnpm may re-resolve when
 * the lockfile is out of sync with package.json, masking lockfile drift
 * and shipping different versions to CI than to dev environments.
 *
 * Pairs with phase 641 (trigger symmetry), phase 626 (pnpm version
 * consistency), phase 627 (node version vs engines), phase 623 (script
 * ref).
 */
describe('CI workflow pnpm install --frozen-lockfile invariant (phase 642)', () => {
  it('every pnpm install in workflows uses --frozen-lockfile', () => {
    const wfDir = path.resolve(__dirname, '../../../.github/workflows');
    const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml')).sort();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(wfDir, f), 'utf-8');
      for (const line of text.split('\n')) {
        // Match `pnpm install` but not `pnpm install-test` etc.
        if (/\bpnpm install\b/.test(line)) {
          if (!line.includes('--frozen-lockfile')) {
            offenders.push(`${f}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
