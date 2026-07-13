import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 677: invariant that depcruise forbidden rule's `from.pathNot`
 * (allowlist exclusion), when present, is non-empty.
 *
 * Rationale (ML#3 accuracy): pathNot is the allowlist exclusion. An
 * empty pathNot ([]) means "no allowlist" — same as not setting pathNot
 * at all. But explicit `pathNot: []` reads as intentional whereas
 * missing pathNot reads as default. Drift to empty array hides intent
 * and breaks future maintenance ("why is this empty?").
 *
 * Pairs with phase 653 (pathNot anchored), phase 638 (regex compile
 * validity), phase 595 (from.path presence), phase 652 (path anchored).
 */
describe('depcruise forbidden rule pathNot non-empty invariant (phase 677)', () => {
  it('every from.pathNot (if present) is non-empty', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    const cfg = require(cfgPath) as {
      forbidden: Array<{
        name: string;
        from?: { pathNot?: string | string[] };
      }>;
    };
    const offenders: string[] = [];
    for (const r of cfg.forbidden) {
      const pathNot = r.from?.pathNot;
      if (pathNot === undefined) continue;
      if (typeof pathNot === 'string') {
        if (pathNot.length === 0) offenders.push(`${r.name}: pathNot is empty string`);
      } else if (Array.isArray(pathNot)) {
        if (pathNot.length === 0) offenders.push(`${r.name}: pathNot is empty array`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
