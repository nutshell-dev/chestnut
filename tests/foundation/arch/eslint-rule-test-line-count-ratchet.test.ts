import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 675: ratchet test that every chestnut-custom ESLint rule test
 * file has line count ≤ 200.
 *
 * 当前最长 152 行（no-silent-x-without-allowed-pattern.test.ts）。soft
 * ceiling 200、buffer ~50 防偶发。Rule test 应只测对应 rule、不应聚合
 * 多种约束（ML#7 模块界面最小）。
 *
 * Mirrors phase 670 (rule line count ≤ 300) to the test-file layer.
 * Pairs with phase 651 (rule test count ratchet ≥ 30).
 */
describe('ESLint rule test line count ratchet (phase 675)', () => {
  it('every rule test file line count ≤ 200', () => {
    const testDir = path.resolve(__dirname, '../../../tests/foundation/eslint-rules');
    const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(testDir, f), 'utf-8').split('\n').length;
      if (lines > 200) offenders.push(`${f} (${lines} lines)`);
    }
    expect(offenders).toEqual([]);
  });
});
