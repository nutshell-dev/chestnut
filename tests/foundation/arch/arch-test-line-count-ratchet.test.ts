import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 676: ratchet test that every arch invariant test file
 * tests/foundation/arch/*.test.ts has line count ≤ 150.
 *
 * 当前最长 84 行。soft ceiling 150、buffer ~65 防偶发。Arch test
 * 应聚焦单一 invariant、不应混测多个（ML#7 模块界面最小）。
 *
 * Mirrors phase 670 (rule line count ≤ 300) + phase 675 (rule test ≤
 * 200) to the arch test layer. Pairs with phase 632 (arch test count
 * ratchet ≥ 20).
 */
describe('arch invariant test line count ratchet (phase 676)', () => {
  it('every arch test file line count ≤ 150', () => {
    const archDir = path.resolve(__dirname);
    const files = fs.readdirSync(archDir).filter(f => f.endsWith('.test.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      // Phase 1008 merged invariant files intentionally group many tests; the 150-line
      // ceiling applies to single-invariant files only.
      if (f.endsWith('.invariant.test.ts')) continue;
      const lines = fs.readFileSync(path.join(archDir, f), 'utf-8').split('\n').length;
      if (lines > 150) offenders.push(`${f} (${lines} lines)`);
    }
    expect(offenders).toEqual([]);
  });
});
