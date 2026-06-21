import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 632: ratchet test for tests/foundation/arch/*.test.ts file count.
 *
 * 当前 main 23 file。ratchet 下限 20（buffer 3 防偶发临时去除）。新增 arch
 * invariant 时持续调高下限。防 future 误删（merge / rebase 漂位 / refactor
 * 失误）→ arch invariant 矩阵静默缩水、规约失防。
 *
 * Mirrors phase 494/563 `depcruise-rule-count-ratchet` (≥ 50 forbidden
 * rules) + phase 631 ESLint custom rule count ratchet (≥ 30) for the
 * arch invariant test surface.
 */
describe('arch invariant test count ratchet (phase 632)', () => {
  it('tests/foundation/arch/*.test.ts count ≥ 20', () => {
    const archDir = path.resolve(__dirname);
    const files = fs.readdirSync(archDir).filter(f => f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(20);
  });
});
