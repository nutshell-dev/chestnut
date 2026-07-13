import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 678: invariant that every depcruise forbidden rule has a `from`
 * field present (even if it's an empty object {}).
 *
 * Rationale (ML#9 explicit pairing): rule's from + to is a source/target
 * pair; from must be explicit (even empty {}) for the rule to have
 * meaningful semantics. A rule with only `to` and no `from` is
 * un-interpretable — depcruise doesn't know where to start scanning.
 *
 * phase 595 covers from.path or from.orphan presence; phase 599 covers
 * to/orphan presence. This phase covers the `from` field itself being
 * present (complementary, defends a more basic invariant).
 *
 * Pairs with phase 595 (from.path|orphan presence), phase 599 (to or
 * orphan), phase 615 (options baseline).
 */
describe('depcruise forbidden rule from presence invariant (phase 678)', () => {
  it('every forbidden rule has from field defined', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    const cfg = require(cfgPath) as {
      forbidden: Array<{ name: string; from?: unknown }>;
    };
    const missing = cfg.forbidden
      .filter(r => r.from === undefined)
      .map(r => r.name);
    expect(missing).toEqual([]);
  });
});
