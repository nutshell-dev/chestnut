import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 638: invariant that every depcruise forbidden rule's regex
 * fields (`from.path`, `from.pathNot`, `to.path`, `to.pathNot`) compile
 * cleanly as JS `RegExp`.
 *
 * Rationale (ML#9 explicit coupling): depcruise config regex strings are
 * passed to the JS RegExp engine. Drift breaks invisibly:
 * - missing escape (e.g. `(` not closed, `\` not doubled) → depcruise
 *   throws "Invalid regular expression" at config load
 * - pnpm lint:arch then fails with cryptic stack; root cause buried in
 *   config dump
 *
 * Catches the failure mode locally + fast — before pushing the broken
 * config to CI / running depcruise.
 *
 * Pairs with phase 595 (from.path|orphan), phase 599 (to/orphan), phase
 * 635 (comment uniqueness).
 */
describe('depcruise forbidden rule regex validity invariant (phase 638)', () => {
  it('every from.path/pathNot + to.path/pathNot string compiles as RegExp', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(cfgPath) as {
      forbidden: Array<{
        name: string;
        from?: { path?: string | string[]; pathNot?: string | string[] };
        to?: { path?: string | string[]; pathNot?: string | string[] };
      }>;
    };
    const offenders: string[] = [];
    const tryCompile = (field: string, ruleName: string, value: unknown) => {
      if (typeof value === 'string') {
        try {
          new RegExp(value);
        } catch (e) {
          offenders.push(`${ruleName}.${field}: ${(e as Error).message}`);
        }
      } else if (Array.isArray(value)) {
        for (const v of value) tryCompile(field, ruleName, v);
      }
    };
    for (const r of cfg.forbidden) {
      tryCompile('from.path', r.name, r.from?.path);
      tryCompile('from.pathNot', r.name, r.from?.pathNot);
      tryCompile('to.path', r.name, r.to?.path);
      tryCompile('to.pathNot', r.name, r.to?.pathNot);
    }
    expect(offenders).toEqual([]);
  });
});
