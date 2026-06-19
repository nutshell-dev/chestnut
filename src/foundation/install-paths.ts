/**
 * @module Foundation.InstallPaths
 *
 * chestnut 安装根 + 子目录 + claw 实例路径推算 + brand type.
 *
 * phase 242 M#5/M#9 真治: phase 78/81 era 迁 → L6 Assembly own、但 3 foundation
 * → L6 反向 imports = M#5 strict violation。user 「好」 ratify Path #6、reverse
 * phase 78/81 era trade-off、install-paths 归 foundation 真 owner (path 是基础设施、
 * 与 fs/identity 同层、与 phase 238 claw-paths 同型基础设施)。
 *
 * sister phase 238 claw-paths 迁 foundation 直接同型真治模板。
 */

import * as path from 'path';

/**
 * Config YAML filename (per-claw + global config 同名).
 * phase 390: 抽 4 site inline 'config.yaml' literal 为 const (M#1 + ML#9)。
 */
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

/**
 * Validate identifier-class param (clawId / skillName / etc) against traversal.
 * @throws Error if name contains '/', '..', is empty, '.' or starts with '.'.
 * Private (internal use by getClawDir only).
 */
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

export function getClawConfigPath(name: string): string {
  return path.join(getClawDir(name), CONFIG_YAML_FILE);
}

// ============================================================================
// phase 84: ChestnutRoot brand + factory + resolveChestnutRoot
// 自 foundation/paths.ts 整迁、chestnut 根 = 装配根本身的类型表达 + 拓扑推算 = L6 own
// ============================================================================

declare const ChestnutRootBrand: unique symbol;
export type ChestnutRoot = string & { readonly [ChestnutRootBrand]: true };
export function makeChestnutRoot(s: string): ChestnutRoot { return s as ChestnutRoot; }

/**
 * 从 clawDir 推算 chestnutRoot 的单一权威函数。
 *
 * 目录拓扑（design/architecture.md 系统拓扑节）：
 *   motion claw：`<root>/motion/`         → motion claw clawDir 的父 = root
 *   普通 claw： `<root>/claws/<id>/`     → 普通 claw clawDir 的祖父 = root
 *
 * 调用方需告知是否 motion（来自 Assembly 装配期 isMotion guard）。
 *
 * @param clawDir 此 claw 的实例目录（branded string）
 * @param isMotion 是否 motion claw（拓扑差异由配置决定）
 * @returns branded ChestnutRoot
 */
export function resolveChestnutRoot(clawDir: string, isMotion: boolean): ChestnutRoot {
  return isMotion
    ? makeChestnutRoot(path.join(clawDir, '..')) // Motion-only callsite: motion clawDir = <root>/motion → root
    : makeChestnutRoot(path.join(clawDir, '..', '..'));
}
