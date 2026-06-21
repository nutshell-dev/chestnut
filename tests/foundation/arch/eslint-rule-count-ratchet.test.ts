import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 631: ratchet test for chestnut-custom ESLint rule count.
 *
 * 当前 32 rule、ratchet 下限 30（buffer 2 防偶发临时去除）。新增 rule 时持续
 * 调高下限、防 future 误删 rule（rebase 错位 / merge 漏 / refactor 失误）→
 * rule 集成静默缩水、编码规约失防。
 *
 * Mirrors phase 494/563 `depcruise-rule-count-ratchet` (≥ 50 forbidden
 * rules) for the ESLint custom rules surface.
 *
 * Pairs with phase 580 (rule ↔ test 1:1), phase 591 (3-way pairing),
 * phase 593 (severity), phase 596 (meta.type), phase 597 (quartet).
 */
describe('ESLint custom rule count ratchet (phase 631)', () => {
  it('chestnut-custom rule files count ≥ 30', () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.js'));
    expect(files.length).toBeGreaterThanOrEqual(30);
  });
});
