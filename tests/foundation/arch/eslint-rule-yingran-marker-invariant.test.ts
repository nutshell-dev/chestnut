import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 598: invariant that every chestnut-custom ESLint rule under
 * .config/eslint-rules/*.js declares a 应然 (prescriptive principle) marker in
 * its file header (first 40 lines).
 *
 * Rationale: every chestnut-custom rule must trace back to a prescriptive
 * principle (M#5 单向, M#3 owner, M#7 边界, 编码规范, etc.). The 应然 marker
 * in the file header articulates *why* the rule exists — without it, the rule
 * decays into a descriptive ad-hoc grep with no anchor for future judgment
 * calls about scope, allowlist, or removal.
 *
 * Pairs with phase 597 (rule structural quartet), phase 596 (meta.type),
 * phase 593 (severity), phase 585 (phase reference in rule + test).
 */
describe('ESLint chestnut-custom rule 应然 marker invariant (phase 598)', () => {
  it('every .config/eslint-rules/*.js header (first 40 lines) contains 应然', () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const missing: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(rulesDir, f), 'utf-8');
      const header = text.split('\n').slice(0, 40).join('\n');
      if (!header.includes('应然')) missing.push(f);
    }
    expect(missing).toEqual([]);
  });
});
