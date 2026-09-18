/**
 * phase 1864 Step J（CT-D13）：ChestnutRoot brand 构造持真实验证。
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  makeChestnutRoot,
  resolveChestnutRoot,
} from '../../../src/foundation/claw-identity/instance-paths.js';

describe('makeChestnutRoot validation (phase 1864 Step J / CT-D13)', () => {
  it('accepts absolute canonical paths', () => {
    expect(makeChestnutRoot('/a/chestnut')).toBe('/a/chestnut');
  });

  it.each([
    ['relative path', 'a/chestnut'],
    ['dot segment', '/a/./chestnut'],
    ['parent segment', '/a/b/../chestnut'],
    ['trailing separator', '/a/chestnut/'],
  ])('rejects non-canonical input: %s', (_label, input) => {
    expect(() => makeChestnutRoot(input)).toThrow(/absolute canonical path/);
  });

  it('resolveChestnutRoot output always passes brand validation', () => {
    // 属性断言：普通 claw（两层 up）与 motion（一层 up）产出均恒过验证
    expect(resolveChestnutRoot('/a/chestnut/claws/claw1', false)).toBe('/a/chestnut');
    expect(resolveChestnutRoot('/a/chestnut/motion', true)).toBe('/a/chestnut');
    // 输入带冗余段时归一化后再构造（不把 '..' 残留带进 brand）
    const redundant = path.join('/a', 'x', '..', 'chestnut', 'claws', 'claw1');
    expect(resolveChestnutRoot(redundant, false)).toBe('/a/chestnut');
  });
});
