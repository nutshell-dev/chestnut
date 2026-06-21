import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 596: invariant that every chestnut-custom ESLint rule under
 * .config/eslint-rules/*.js exports `meta.type === 'problem'`.
 *
 * Rationale: all chestnut-custom rules encode architectural / coding standard
 * violations (M#5 unidirectional dep, M#3 ownership, M#7 boundary, coding
 * conventions) — never cosmetic suggestions or layout style. Drifting to
 * 'suggestion' or 'layout' would weaken IDE surfacing + miscategorize the
 * intent of the rule.
 *
 * Pairs with phase 587 (rule test uses RuleTester), phase 589 (rule ↔ config
 * import 1:1), phase 591 (3-way plugin/rules pairing), phase 593 (severity
 * = 'error'), phase 585 (phase reference in rule + test).
 */
describe('ESLint chestnut-custom rule meta.type invariant (phase 596)', () => {
  it('every .config/eslint-rules/*.js has meta.type === "problem"', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { type?: string } };
      };
      const type = mod?.default?.meta?.type;
      if (type !== 'problem') offenders.push(`${f}: meta.type=${String(type)}`);
    }
    expect(offenders).toEqual([]);
  });
});
