import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 667: invariant that every chestnut-custom rule .js source file
 * contains exactly one top-level `export default ` line (ESM syntax).
 *
 * Rationale (ML#3 single-source export form): ESLint flat config loads
 * rule modules via `await import()`. ESM `export default` is the
 * contract. Drift breaks invisibly:
 * - swap to `module.exports = ` (CJS) → dynamic import sees default
 *   wrapped under .default property mismatch, rule fails to load (or
 *   loads as undefined → ESLint silently skips it)
 * - more than one `export default` → SyntaxError at load
 *
 * phase 666 covered default export shape ({meta, create}); this phase
 * verifies the export FORM (ESM single default) at the source layer.
 *
 * Pairs with phase 666 (export keys strict), phase 665 (meta keys
 * strict), phase 597 (structural quartet).
 */
describe('ESLint rule ESM export default invariant (phase 667)', () => {
  it('every rule .js has exactly 1 top-level `export default ` line', () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    const re = /^export default /gm;
    for (const f of files) {
      const text = fs.readFileSync(path.join(rulesDir, f), 'utf-8');
      const matches = text.match(re) ?? [];
      if (matches.length !== 1) {
        offenders.push(`${f}: ${matches.length} 'export default' lines`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
