import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 653: invariant that every depcruise forbidden rule's
 * `from.pathNot` (allowlist exclusion regex) is anchored at either the
 * start (`^`) or end (`$`).
 *
 * phase 652 covered from.path/to.path requiring start anchor (`^`).
 * pathNot has a different semantic — it can legitimately anchor at the
 * end (e.g. `\.d\.ts$` excludes files ending in `.d.ts`). But it MUST
 * anchor at one end; an unanchored pathNot like `index.ts` would match
 * `node_modules/foo/index.ts` and `src/index.ts` indiscriminately,
 * making the allowlist range explode.
 *
 * Pairs with phase 652 (from.path/to.path start-anchored), phase 638
 * (regex compile validity), phase 595 (from.path presence).
 */
describe('depcruise forbidden rule pathNot anchored invariant (phase 653)', () => {
  it('every from.pathNot string starts with ^ OR ends with $', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    const cfg = require(cfgPath) as {
      forbidden: Array<{
        name: string;
        from?: { pathNot?: string | string[] };
      }>;
    };
    const offenders: string[] = [];
    const check = (ruleName: string, value: unknown) => {
      if (typeof value === 'string') {
        if (!value.startsWith('^') && !value.endsWith('$')) {
          offenders.push(`${ruleName}.from.pathNot: ${value}`);
        }
      } else if (Array.isArray(value)) {
        for (const v of value) check(ruleName, v);
      }
    };
    for (const r of cfg.forbidden) {
      check(r.name, r.from?.pathNot);
    }
    expect(offenders).toEqual([]);
  });
});
