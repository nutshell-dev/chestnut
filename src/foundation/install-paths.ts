/**
 * @module L2a.ChestnutPaths
 *
 * chestnut workspace root + 子目录路径原语。
 * claw 实例路径解析已迁 L4 ClawTopology (phase 704)。
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
