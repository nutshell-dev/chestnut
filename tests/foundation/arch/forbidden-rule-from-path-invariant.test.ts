import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 595: invariant that every depcruise forbidden rule has a `from.path` or
 * `from.orphan` field defined (whitelisting `no-circular`, which is a
 * whole-graph cycle check without a from dimension).
 *
 * A rule without a `from` qualifier silently matches every source file in the
 * repo, producing false positives at scale or — depending on the `to`
 * configuration — silently matching nothing. Either failure mode masks intent.
 *
 * Pairs with phase 509 forbidden-rule-severity-invariant + phase 582
 * forbidden-rule-phase-reference + phase 579 forbidden-rule-naming-convention.
 */
describe('depcruise forbidden rule from.path|orphan invariant (phase 595)', () => {
  it('every forbidden rule has from.path or from.orphan (except no-circular)', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(cfgPath) as {
      forbidden: Array<{
        name: string;
        from?: { path?: string | string[]; orphan?: boolean };
      }>;
    };
    const WHITELIST = new Set(['no-circular']);
    const missing: string[] = [];
    for (const r of cfg.forbidden) {
      if (WHITELIST.has(r.name)) continue;
      const hasPath = !!(r.from && r.from.path);
      const hasOrphan = !!(r.from && r.from.orphan);
      if (!hasPath && !hasOrphan) missing.push(r.name);
    }
    expect(missing).toEqual([]);
  });
});
