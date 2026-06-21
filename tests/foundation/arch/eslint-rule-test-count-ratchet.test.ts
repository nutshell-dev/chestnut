import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 651: ratchet test for tests/foundation/eslint-rules/*.test.ts
 * file count.
 *
 * 当前 32 file、ratchet 下限 30（buffer 2）。新增 rule test 时持续调高下限。
 * 防 future 误删（rebase 错位 / merge 漏 / refactor 失误）→ rule 行为可能
 * 漂但没测发现。
 *
 * Mirrors phase 631 (.config/eslint-rules count ≥ 30) + phase 632 (arch
 * test count ≥ 20) for the eslint-rule test surface. phase 580 1:1 pairing
 * binds rule + test dir counts implicitly; this ratchet provides explicit
 * lower-bound on the test side.
 */
describe('ESLint rule test count ratchet (phase 651)', () => {
  it('tests/foundation/eslint-rules/*.test.ts count ≥ 30', () => {
    const testDir = path.resolve(
      __dirname,
      '../../../tests/foundation/eslint-rules',
    );
    const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(30);
  });
});
