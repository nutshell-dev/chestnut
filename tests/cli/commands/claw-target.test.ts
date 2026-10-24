/**
 * phase 1986 Step H：claw-target 分支矩阵。
 *
 * resolveClawTarget / assertPublishedClaw / assertClawDirExists 的
 * motion 与普通 claw 分支——真实临时工作区（NodeFileSystem）+ 真实路径解析，
 * 不 mock 被测模块自身。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  resolveClawTarget,
  assertPublishedClaw,
  assertClawDirExists,
} from '../../../src/cli/commands/claw-target.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CliError } from '../../../src/cli/errors.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

function fakeRootConfig() {
  return {
    loadGlobal: vi.fn(() => ({}) as never),
    // 真实 config 存在性判定：文件在则已发布
    loadClaw: vi.fn((configPath: string) =>
      existsSync(configPath) ? ({} as never) : undefined),
  };
}

describe('claw-target (phase 1986)', () => {
  let workspaceRoot: string;
  let chestnutRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createTrackedTempDir('claw-target-1986-');
    chestnutRoot = path.join(workspaceRoot, '.chestnut');
    await fs.mkdir(path.join(chestnutRoot, 'claws', 'alice'), { recursive: true });
    await fs.writeFile(path.join(chestnutRoot, 'claws', 'alice', 'config.yaml'), 'name: alice\n');
    vi.stubEnv('CHESTNUT_ROOT', workspaceRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupTempDir(workspaceRoot);
  });

  async function materializeMotion(): Promise<string> {
    const motionDir = path.join(chestnutRoot, 'motion');
    await fs.mkdir(motionDir, { recursive: true });
    return motionDir;
  }

  it('regular claw → claws/<id>，isMotion=false', () => {
    const target = resolveClawTarget('alice');
    expect(target.clawDir).toBe(path.join(chestnutRoot, 'claws', 'alice'));
    expect(target.isMotion).toBe(false);
  });

  it('motion → <root>/motion，isMotion=true', () => {
    const target = resolveClawTarget('motion');
    expect(target.clawDir).toBe(path.join(chestnutRoot, 'motion'));
    expect(target.isMotion).toBe(true);
  });

  it('assertPublishedClaw：regular 缺 config → does not exist', () => {
    const deps = { fsFactory, rootConfig: fakeRootConfig() };
    expect(() => assertPublishedClaw(deps, 'bob')).toThrow(CliError);
    expect(() => assertPublishedClaw(deps, 'bob')).toThrow(/Claw "bob" does not exist/);
  });

  it('assertPublishedClaw：regular 缺 config + notFoundHint → 追加提示', () => {
    const deps = { fsFactory, rootConfig: fakeRootConfig() };
    expect(() =>
      assertPublishedClaw(deps, 'bob', { notFoundHint: 'Try `chestnut claw list` to see existing claws.' }),
    ).toThrow(/Claw "bob" does not exist\. Try `chestnut claw list` to see existing claws\./);
  });

  it('assertPublishedClaw：regular 有 config → 返回同一 target', () => {
    const deps = { fsFactory, rootConfig: fakeRootConfig() };
    const target = assertPublishedClaw(deps, 'alice');
    expect(target.clawDir).toBe(path.join(chestnutRoot, 'claws', 'alice'));
    expect(target.isMotion).toBe(false);
  });

  it('assertPublishedClaw：motion 缺目录 → Motion is not initialized', () => {
    const deps = { fsFactory, rootConfig: fakeRootConfig() };
    expect(() => assertPublishedClaw(deps, 'motion')).toThrow(CliError);
    expect(() => assertPublishedClaw(deps, 'motion')).toThrow(
      /Motion is not initialized: .* does not exist\. Run `chestnut start` first\./,
    );
  });

  it('assertPublishedClaw：motion 有目录 → 返回 target（无需 config.yaml）', async () => {
    await materializeMotion();
    const deps = { fsFactory, rootConfig: fakeRootConfig() };
    const target = assertPublishedClaw(deps, 'motion');
    expect(target.clawDir).toBe(path.join(chestnutRoot, 'motion'));
    expect(target.isMotion).toBe(true);
    // motion 不以 config.yaml 为存在依据
    expect(deps.rootConfig.loadClaw).not.toHaveBeenCalled();
  });

  it('assertClawDirExists：缺失 → Claw directory not found（位置无关文案）', () => {
    const deps = { fsFactory };
    expect(() => assertClawDirExists(deps, 'ghost')).toThrow(CliError);
    expect(() => assertClawDirExists(deps, 'ghost')).toThrow(
      new RegExp(`^Claw directory not found: ${escapeRegExp(path.join(chestnutRoot, 'claws', 'ghost'))}$`),
    );
  });

  it('assertClawDirExists：存在 → 返回 target', () => {
    const deps = { fsFactory };
    const target = assertClawDirExists(deps, 'alice');
    expect(target.clawDir).toBe(path.join(chestnutRoot, 'claws', 'alice'));
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
