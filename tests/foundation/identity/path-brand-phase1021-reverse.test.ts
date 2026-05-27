/**
 * @module tests.foundation.identity.path-brand-phase1021-reverse
 * phase 1376 sub-2: ClawforumRoot brand compile-time defense against phase 1021 path-mixup bug.
 *
 * phase 1021 real bug: assemble.ts:520 path.dirname(path.dirname(clawDir)) double-strip
 * Expected = <root>/.clawforum/ (ClawforumRoot)
 * Actual   = <root>/ (FilesystemPath / out-of-scope)
 * After branding: path.dirname returns string → can't assign to ClawforumRoot → TS2322.
 */

import { describe, it, expect } from 'vitest';
import { type ClawDir, type ClawforumRoot, makeClawDir, makeClawforumRoot } from '../../../src/foundation/identity/index.js';
import * as path from 'path';

describe('phase 1021 path-mixup compile-time defense', () => {
  it('// @ts-expect-error: path.dirname returns string, not ClawforumRoot', () => {
    const clawDir = makeClawDir('/abs/.clawforum/motion');
    // @ts-expect-error — path.dirname returns string (untyped) / can't assign to ClawforumRoot
    const wrongRoot: ClawforumRoot = path.dirname(clawDir);
    expect(wrongRoot).toBeDefined();
  });

  it('// @ts-expect-error: dirname(dirname()) double-strip (phase 1021 real bug)', () => {
    const clawDir = makeClawDir('/abs/.clawforum/motion');
    // @ts-expect-error
    const wrongRoot: ClawforumRoot = path.dirname(path.dirname(clawDir));
    expect(wrongRoot).toBeDefined();
  });

  it('正向: makeClawforumRoot 构造 + 传 typed fn 合法', () => {
    const root: ClawforumRoot = makeClawforumRoot('/abs/.clawforum');
    expect(root).toBe('/abs/.clawforum');
  });

  it('正向: makeClawforumRoot(path.dirname(clawDir)) 入口构造合法', () => {
    const clawDir = makeClawDir('/abs/.clawforum/motion');
    const root: ClawforumRoot = makeClawforumRoot(path.dirname(clawDir));
    expect(root).toBe('/abs/.clawforum');
  });
});
