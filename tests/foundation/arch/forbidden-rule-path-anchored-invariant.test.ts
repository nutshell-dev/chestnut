import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 652: invariant that every depcruise forbidden rule's path regex
 * (`from.path`, `to.path`, supporting string or string[]) is anchored at
 * the start with `^`.
 *
 * Rationale (ML#3 accuracy + intent): without `^` the regex matches
 * anywhere in the file path. e.g., `src/foo` as `from.path` also matches
 * `node_modules/whatever/src/foo` — producing false positives that mask
 * the rule's intent + spam logs.
 *
 * Pairs with phase 638 (regex compile validity), phase 595 (from.path
 * presence), phase 599 (to/orphan presence), phase 649 (rule name
 * kebab-case).
 */
describe('depcruise forbidden rule path anchored invariant (phase 652)', () => {
  it('every from.path / to.path string starts with ^', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    const cfg = require(cfgPath) as {
      forbidden: Array<{
        name: string;
        from?: { path?: string | string[] };
        to?: { path?: string | string[] };
      }>;
    };
    const offenders: string[] = [];
    const check = (field: string, ruleName: string, value: unknown) => {
      if (typeof value === 'string') {
        if (!value.startsWith('^')) {
          offenders.push(`${ruleName}.${field}: ${value}`);
        }
      } else if (Array.isArray(value)) {
        for (const v of value) check(field, ruleName, v);
      }
    };
    for (const r of cfg.forbidden) {
      check('from.path', r.name, r.from?.path);
      check('to.path', r.name, r.to?.path);
    }
    expect(offenders).toEqual([]);
  });
});
