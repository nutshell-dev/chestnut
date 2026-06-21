import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 649: invariant that every depcruise forbidden rule name matches
 * strict kebab-case `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`.
 *
 * phase 579 covers prefix convention (must start with `no-` or contain
 * `-only-`) but doesn't enforce strict kebab-case format — e.g.,
 * `no-BadName` passes 579 but contains camelCase.
 *
 * Mirrors phase 648 (ESLint custom rule filename kebab-case) for the
 * depcruise rule-name surface. Pairs with phase 579 (prefix), phase
 * 559 (name uniqueness), phase 635 (comment uniqueness).
 */
describe('depcruise forbidden rule name kebab-case invariant (phase 649)', () => {
  it('every rule.name matches /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(cfgPath) as { forbidden: Array<{ name: string }> };
    const kebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    const offenders = cfg.forbidden
      .filter(r => !kebab.test(r.name))
      .map(r => r.name);
    expect(offenders).toEqual([]);
  });
});
