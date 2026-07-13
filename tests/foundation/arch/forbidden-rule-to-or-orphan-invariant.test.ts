import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 599: invariant that every depcruise forbidden rule has a target
 * dimension defined: `to.path`, `to.dependencyTypes`, `to.circular === true`,
 * or pairs with `from.orphan === true` (orphan check uses from.orphan + empty
 * to).
 *
 * Rationale: a forbidden rule without a target dimension has no meaningful
 * match — it either silently matches nothing or silently matches everything,
 * depending on the depcruise version. Both failure modes mask intent and
 * decay rule efficacy as the codebase grows.
 *
 * Pairs with phase 595 (from.path|orphan invariant — source dimension), phase
 * 582 (phase reference), phase 579 (naming convention), phase 509 (severity).
 */
describe('depcruise forbidden rule to/orphan invariant (phase 599)', () => {
  it('every forbidden rule has to.path, to.dependencyTypes, to.circular, or from.orphan', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    const cfg = require(cfgPath) as {
      forbidden: Array<{
        name: string;
        from?: { orphan?: boolean };
        to?: {
          path?: string | string[];
          dependencyTypes?: string[];
          circular?: boolean;
        };
      }>;
    };
    const missing: string[] = [];
    for (const r of cfg.forbidden) {
      const hasToPath = !!(r.to && r.to.path);
      const hasToDepTypes = !!(r.to && r.to.dependencyTypes);
      const hasToCircular = r.to?.circular === true;
      const hasFromOrphan = r.from?.orphan === true;
      if (!hasToPath && !hasToDepTypes && !hasToCircular && !hasFromOrphan) {
        missing.push(r.name);
      }
    }
    expect(missing).toEqual([]);
  });
});
