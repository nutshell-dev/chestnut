/**
 * @module tests.design.no-chestnut-dir-naming
 * phase 1376 sub-4: mechanical lint ban `chestnutDir` keyword in src/.
 * per M#1 同型职责不分双名 / chestnutRoot/chestnutDir 同义统一。
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('no chestnutDir: keyword in src/ (phase 1376 同义统一)', () => {
  it('src/ 中 0 处 chestnutDir 残留', () => {
    const result = execSync(
      `grep -rn '\\bchestnutDir\\b' src/ --include='*.ts' || true`,
      { cwd: process.cwd() }
    ).toString();
    expect(result.trim()).toBe('');
  });
});
