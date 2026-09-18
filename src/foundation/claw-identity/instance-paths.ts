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

/**
 * ChestnutRoot brand factory。
 *
 * phase 1864 Step J（CT-D13）：brand 构造持真实验证——输入必须是绝对且已归一
 * （canonical，无 `..` / 无尾分隔符残留）的路径；非规范输入显式失败，
 * 不留 unchecked cast。
 */
export function makeChestnutRoot(s: string): ChestnutRoot {
  if (!path.isAbsolute(s) || path.resolve(s) !== s) {
    throw new Error(
      `makeChestnutRoot: input must be an absolute canonical path (no '..' / trailing separator), got ${JSON.stringify(s)}`,
    );
  }
  return s as ChestnutRoot;
}

/**
 * 从 claw 目录反推 chestnut root（motion 一层 up / 普通 claw 两层 up）。
 * phase 1864 Step J（CT-D13）：先归一化再构造，保证产出恒过 brand 验证。
 */
export function resolveChestnutRoot(clawDir: string, isMotion: boolean): ChestnutRoot {
  return makeChestnutRoot(
    path.resolve(path.join(clawDir, '..', ...(isMotion ? [] : ['..']))),
  );
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
