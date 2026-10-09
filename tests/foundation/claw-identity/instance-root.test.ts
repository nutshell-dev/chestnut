/**
 * Phase 1930 Step B：实例根路径解析矩阵。
 *
 * `getChestnutRoot()` 是唯一实例定位入口：无 env 用 cwd、相对/空 env 在调用
 * 位置 `path.resolve` 成绝对规范路径，返回 ChestnutRoot brand（恒过
 * makeChestnutRoot 验证）。named subroot / claw dir 均从实例根派生，
 * 公共父目录 API（getWorkspaceRoot）已删除。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  getChestnutRoot,
  getNamedSubrootDir,
  getClawDir,
  makeChestnutRoot,
} from '../../../src/foundation/claw-identity/instance-paths.js';

const originalRoot = process.env.CHESTNUT_ROOT;

afterEach(() => {
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  vi.restoreAllMocks();
});

function stubCwd(dir: string): void {
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
}

describe('getChestnutRoot 解析矩阵 (Phase 1930 Step B)', () => {
  it('无 env：解析为 <cwd>/.chestnut（绝对规范）', () => {
    delete process.env.CHESTNUT_ROOT;
    stubCwd('/work/alpha');
    expect(getChestnutRoot()).toBe('/work/alpha/.chestnut');
  });

  it('绝对 env：解析为 <env>/.chestnut，与 cwd 无关', () => {
    process.env.CHESTNUT_ROOT = '/env/root';
    stubCwd('/unrelated/cwd');
    expect(getChestnutRoot()).toBe('/env/root/.chestnut');
  });

  it('相对 env：在调用位置相对 cwd 解析成绝对路径（child 不二次解释）', () => {
    process.env.CHESTNUT_ROOT = 'rel/root';
    stubCwd('/work/beta');
    expect(getChestnutRoot()).toBe('/work/beta/rel/root/.chestnut');
  });

  it('空值 env：保持现有边界（视为相对空段 → <cwd>/.chestnut）', () => {
    process.env.CHESTNUT_ROOT = '';
    stubCwd('/work/gamma');
    expect(getChestnutRoot()).toBe('/work/gamma/.chestnut');
  });

  it('env 含尾分隔符/冗余段：归一化后仍过 brand 验证', () => {
    process.env.CHESTNUT_ROOT = '/a/b/';
    expect(getChestnutRoot()).toBe('/a/b/.chestnut');
    process.env.CHESTNUT_ROOT = '/a/x/../b';
    expect(getChestnutRoot()).toBe('/a/b/.chestnut');
  });

  it('返回值恒过 makeChestnutRoot brand 验证（无 unchecked cast）', () => {
    process.env.CHESTNUT_ROOT = 'rel';
    stubCwd('/work/delta');
    expect(() => makeChestnutRoot(getChestnutRoot())).not.toThrow();
  });

  it('多实例：不同 env 解析出不同实例根', () => {
    process.env.CHESTNUT_ROOT = '/inst/one';
    const one = getChestnutRoot();
    process.env.CHESTNUT_ROOT = '/inst/two';
    const two = getChestnutRoot();
    expect(one).toBe('/inst/one/.chestnut');
    expect(two).toBe('/inst/two/.chestnut');
    expect(one).not.toBe(two);
  });
});

describe('派生路径从实例根出发 (Phase 1930 Step B)', () => {
  it('getNamedSubrootDir / getClawDir 与 getChestnutRoot 一致', () => {
    process.env.CHESTNUT_ROOT = '/ws';
    expect(getNamedSubrootDir('motion')).toBe(path.join(getChestnutRoot(), 'motion'));
    expect(getClawDir('claw-1')).toBe(path.join(getChestnutRoot(), 'claws', 'claw-1'));
  });
});
