/**
 * @module tests.design.no-clawforum-dir-naming
 * phase 1376 sub-4: mechanical lint ban `clawforumDir` keyword in src/.
 * per ML#1 同型职责不分双名 / clawforumRoot/clawforumDir 同义统一。
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('no clawforumDir: keyword in src/ (phase 1376 同义统一)', () => {
  it('src/ 中 0 处 clawforumDir 残留', () => {
    const result = execSync(
      `grep -rn '\\bclawforumDir\\b' src/ --include='*.ts' || true`,
      { cwd: process.cwd() }
    ).toString();
    expect(result.trim()).toBe('');
  });
});
