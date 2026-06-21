import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 670: ratchet test that every chestnut-custom ESLint rule .js
 * file has line count ≤ 300.
 *
 * 当前最长 239 行（foundation-no-business-role-literal.js）。soft
 * ceiling 300、buffer ≥ 60 防偶发临时长。新增 rule 增长跨越 300 → review
 * 时强制思考拆分（ML#7 模块界面最小、单一职责）。
 *
 * Pairs with phase 631 (rule count ratchet ≥ 30), phase 632 (arch
 * test count ratchet ≥ 20).
 */
describe('ESLint rule line count ratchet (phase 670)', () => {
  it('every rule .js file line count ≤ 300', () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.js'));
    const offenders: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(rulesDir, f), 'utf-8').split('\n').length;
      if (lines > 300) offenders.push(`${f} (${lines} lines)`);
    }
    expect(offenders).toEqual([]);
  });
});
