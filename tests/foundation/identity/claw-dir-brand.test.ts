/**
 * @module tests.foundation.identity.claw-dir-brand
 * phase 1376 sub-3: ClawDir brand compile-time defense.
 */

import { describe, it, expect } from 'vitest';
import { type ClawDir, makeClawDir } from '../../../src/foundation/identity/index.js';
import * as path from 'path';

describe('ClawDir brand', () => {
  it('正向: makeClawDir 构造合法', () => {
    const clawDir: ClawDir = makeClawDir('/abs/.clawforum/claws/test');
    expect(clawDir).toBe('/abs/.clawforum/claws/test');
  });

  it('// @ts-expect-error: 字符串字面量不能直接赋 ClawDir', () => {
    // @ts-expect-error
    const wrong: ClawDir = '/raw/string';
    expect(wrong).toBeDefined();
  });

  it('// @ts-expect-error: path.join 返 string 不能直接赋 ClawDir', () => {
    // @ts-expect-error
    const wrong: ClawDir = path.join('/root', '.clawforum', 'motion');
    expect(wrong).toBeDefined();
  });
});
