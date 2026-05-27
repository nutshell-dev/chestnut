/**
 * @module tests.foundation.identity.archive-dir-brand
 * phase 1376 sub-4: ArchiveDir brand compile-time defense.
 */

import { describe, it, expect } from 'vitest';
import { type ArchiveDir, makeArchiveDir } from '../../../src/core/contract/types.js';
import * as path from 'path';

describe('ArchiveDir brand', () => {
  it('正向: makeArchiveDir 构造合法', () => {
    const archiveDir: ArchiveDir = makeArchiveDir('/abs/.clawforum/claws/test/contract/archive');
    expect(archiveDir).toBe('/abs/.clawforum/claws/test/contract/archive');
  });

  it('// @ts-expect-error: 字符串字面量不能直接赋 ArchiveDir', () => {
    // @ts-expect-error
    const wrong: ArchiveDir = '/raw/string';
    expect(wrong).toBeDefined();
  });

  it('// @ts-expect-error: path.join 返 string 不能直接赋 ArchiveDir', () => {
    // @ts-expect-error
    const wrong: ArchiveDir = path.join('/root', 'archive');
    expect(wrong).toBeDefined();
  });
});
