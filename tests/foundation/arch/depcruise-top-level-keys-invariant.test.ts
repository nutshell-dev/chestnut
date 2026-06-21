import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 659: invariant that depcruise config has exactly {forbidden,
 * options} as top-level keys — no `allowed[]` (allowlist) or other
 * model fields.
 *
 * Rationale (ML#3 single model): chestnut adopts the forbidden-only
 * model — explicit denylist, anything not denied is allowed. Mixing in
 * `allowed[]` (denylist) or other depcruise features (extends, etc.)
 * creates rule-priority ambiguity:
 * - same dep matching one forbidden + one allowed → which wins?
 * - rules silently override each other; debug becomes guesswork
 *
 * Pairs with phase 615 (options baseline), phase 633 (severity=error
 * default), phase 595 (from.path), phase 599 (to/orphan).
 */
describe('depcruise config top-level keys invariant (phase 659)', () => {
  it('top-level keys === {forbidden, options}', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(cfgPath) as Record<string, unknown>;
    const keys = new Set(Object.keys(cfg));
    expect([...keys].sort()).toEqual(['forbidden', 'options']);
  });
});
