import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 633: invariant that every depcruise forbidden rule's severity is
 * 'error', except for the explicit `WARN_WHITELIST` (currently just
 * `no-orphans`).
 *
 * Rationale (ML#3 fail-loud baseline): architectural invariants must
 * fail-loud (severity='error'). `warn` is reserved for the orphan-detection
 * case (high false-positive rate during refactors) and must be whitelisted
 * explicitly.
 *
 * Refines phase 509 (severity ∈ {error, warn} — coarse): this phase makes
 * the default = 'error' and forces every 'warn' to be deliberate and
 * recorded in the whitelist.
 *
 * Pairs with phase 595 (from.path), phase 599 (to/orphan), phase 615
 * (options baseline), phase 633 ratchet for forbidden rule severity.
 */
describe('depcruise forbidden rule severity=error default invariant (phase 633)', () => {
  it('every rule severity === "error" except WARN_WHITELIST', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    const cfg = require(cfgPath) as {
      forbidden: Array<{ name: string; severity: string }>;
    };
    const WARN_WHITELIST = new Set(['no-orphans']);
    const offenders: string[] = [];
    for (const r of cfg.forbidden) {
      if (WARN_WHITELIST.has(r.name)) {
        if (r.severity !== 'warn') {
          offenders.push(`${r.name}: whitelist expects 'warn', got '${r.severity}'`);
        }
      } else {
        if (r.severity !== 'error') {
          offenders.push(`${r.name}: severity='${r.severity}' (expected 'error')`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
