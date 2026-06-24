/**
 * @module tests.foundation.identity.path-brand-phase1021-reverse
 * phase 1376 sub-2: ChestnutRoot brand compile-time defense against phase 1021 path-mixup bug.
 *
 * phase 1021 real bug: assemble.ts:520 path.dirname(path.dirname(clawDir)) double-strip
 * Expected = <root>/.chestnut/ (ChestnutRoot)
 * Actual   = <root>/ (FilesystemPath / out-of-scope)
 * After branding: path.dirname returns string → can't assign to ChestnutRoot → TS2322.
 */

import { type ChestnutRoot, makeChestnutRoot } from '../../../src/core/claw-topology/claw-instance-paths.js';
import { describe, it, expect } from 'vitest';
import * as path from 'path';

describe('phase 1021 path-mixup compile-time defense', () => {
  it('// @ts-expect-error: path.dirname returns string, not ChestnutRoot', () => {
    const clawDir = '/abs/.chestnut/motion';
    // @ts-expect-error — path.dirname returns string (untyped) / can't assign to ChestnutRoot
    const wrongRoot: ChestnutRoot = path.dirname(clawDir);
    expect(wrongRoot).toBeDefined();
  });

  it('// @ts-expect-error: dirname(dirname()) double-strip (phase 1021 real bug)', () => {
    const clawDir = '/abs/.chestnut/motion';
    // @ts-expect-error
    const wrongRoot: ChestnutRoot = path.dirname(path.dirname(clawDir));
    expect(wrongRoot).toBeDefined();
  });

  it('正向: makeChestnutRoot 构造 + 传 typed fn 合法', () => {
    const root: ChestnutRoot = makeChestnutRoot('/abs/.chestnut');
    expect(root).toBe('/abs/.chestnut');
  });

  it('正向: makeChestnutRoot(path.dirname(clawDir)) 入口构造合法', () => {
    const clawDir = '/abs/.chestnut/motion';
    const root: ChestnutRoot = makeChestnutRoot(path.dirname(clawDir));
    expect(root).toBe('/abs/.chestnut');
  });
});
