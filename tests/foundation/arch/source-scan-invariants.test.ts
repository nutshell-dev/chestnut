import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 502: ratchet test ensuring no "L0" string appears in src/.
 *
 * phase 441 user clarified: L0 is a doc/spec-only concept, not allowed
 * in code. phase 441 removed the only L0 literal (formerly in root constants
 * file's "L0 shared constants only" comment、phase 520 整 file 删).
 *
 * This ratchet prevents regression.
 */
describe('no L0 in src ratchet (phase 502)', () => {
  it('no L0 word-boundary string appears in src/', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rnE "\\bL0\\b" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });
});

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
