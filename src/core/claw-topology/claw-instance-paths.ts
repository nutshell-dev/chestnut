/**
 * @module L4.ClawTopology
 *
 * claw 实例路径解析 + ChestnutRoot 品牌类型。
 * architecture.md §31 ClawTopology：「chestnut 拓扑信息持有者 + 跨 claw 读取统一对外入口」。
 * phase 704 自 foundation/install-paths.ts claw 部分迁入（M#3 资源唯一归属）。
 */

import * as path from 'path';
import { getWorkspaceRoot, CONFIG_YAML_FILE } from '../../foundation/install-paths.js';

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

declare const ChestnutRootBrand: unique symbol;
export type ChestnutRoot = string & { readonly [ChestnutRootBrand]: true };
export function makeChestnutRoot(s: string): ChestnutRoot { return s as ChestnutRoot; }

export function resolveChestnutRoot(clawDir: string, isMotion: boolean): ChestnutRoot {
  return isMotion
    ? makeChestnutRoot(path.join(clawDir, '..'))
    : makeChestnutRoot(path.join(clawDir, '..', '..'));
}
