/**
 * @module L2c.ClawIdentity.InstancePaths
 *
 * chestnut 安装路径原语：workspace root、chestnut root、named subroot、claw 目录、
 * claw config 位置与 claws 容器枚举。
 *
 * phase 1864 Step B（CT-D1 + CT-D5）：自 core/claw-topology/claw-instance-paths.ts
 * 迁入（安装路径 API 归稳定路径 owner；ClawTopology 只消费 root/location）。
 * 函数体 1:1 搬运（纯 path 计算 + 传入 fs 参数式），零语义漂移。
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';

/** Config YAML filename (per-claw + global config 同名). */
export const CONFIG_YAML_FILE = 'config.yaml' as const;

/** Workspace root — prefers CHESTNUT_ROOT env var (inherited by exec child processes). */
export function getWorkspaceRoot(): string {
  return process.env.CHESTNUT_ROOT ?? process.cwd();
}

export function getChestnutRoot(): string {
  return path.join(getWorkspaceRoot(), '.chestnut');
}

/**
 * Generic helper to get a named subroot dir under .chestnut/.
 *
 * @param name - subroot name (caller-owned, e.g., motion, claws)
 */
export function getNamedSubrootDir(name: string): string {
  return path.join(getWorkspaceRoot(), '.chestnut', name);
}

function assertSafeClawId(name: string): void {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name.startsWith('.') ||
    name.includes('/') ||
    name.includes('\\') ||
    /[\x00-\x1f]/.test(name) ||
    name.includes('..')
  ) {
    throw new Error(`Invalid claw id: ${JSON.stringify(name)}`);
  }
}

export function getClawDir(name: string): string {
  assertSafeClawId(name);
  return path.join(getWorkspaceRoot(), '.chestnut', 'claws', name);
}

/**
 * Relative claw directory path from the chestnut root.
 * For callers that already have a chroot/baseDir and need `claws/<name>`.
 */
export function getRelativeClawDir(name: string): string {
  assertSafeClawId(name);
  return path.join(CLAWS_DIR, name);
}

export function getClawConfigPath(name: string): string {
  return path.join(getClawDir(name), CONFIG_YAML_FILE);
}

declare const ChestnutRootBrand: unique symbol;
export type ChestnutRoot = string & { readonly [ChestnutRootBrand]: true };
export function makeChestnutRoot(s: string): ChestnutRoot { return s as ChestnutRoot; }

export function resolveChestnutRoot(clawDir: string, isMotion: boolean): ChestnutRoot {
  return isMotion
    ? makeChestnutRoot(path.join(clawDir, '..'))
    : makeChestnutRoot(path.join(clawDir, '..', '..'));
}

/** 复数 claws 容器目录名。phase 705 自 foundation/claw-paths.ts 迁入。 */
export const CLAWS_DIR = 'claws' as const;

/**
 * Enumerate all claw IDs (sub-directories) under clawsDir.
 *
 * Filter: 默 `.filter(e => e.isDirectory)` (DP「不丢弃静默」+ safer corrupt FS case).
 */
export function enumerateClaws(fs: FileSystem, clawsDir: string): string[] {
  return fs
    .listSync(clawsDir, { includeDirs: true })
    .filter(e => e.isDirectory)
    .map(e => e.name);
}
