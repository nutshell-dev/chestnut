/**
 * @module L4.ClawTopology
 *
 * claw 实例路径解析 + ChestnutRoot 品牌类型 + 复数 claws 容器/枚举。
 * architecture.md §31 ClawTopology：「chestnut 拓扑信息持有者 + 跨 claw 读取统一对外入口」。
 * phase 704 自 foundation/install-paths.ts claw 部分迁入（M#3 资源唯一归属）。
 * phase 705 自 foundation/claw-paths.ts 迁入 CLAWS_DIR / enumerateClaws。
 * phase 713 自 foundation/install-paths.ts 迁入 workspace 路径原语（M#3 资源唯一归属）。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { INBOX_PENDING_DIR } from '../../foundation/messaging/dirs.js';
import { notifyClaw } from '../../foundation/messaging/notify.js';
import type { InboxMessageOptionsBase } from '../../foundation/messaging/inbox-writer.js';
import type { AuditLog } from '../../foundation/audit/index.js';

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

/** 复数 claws 容器目录名。phase 705 自 foundation/claw-paths.ts 迁入 L4.ClawTopology。 */
export const CLAWS_DIR = 'claws' as const;

/**
 * Enumerate all claw IDs (sub-directories) under clawsDir.
 *
 * Filter: 默 `.filter(e => e.isDirectory)` (DP「不丢弃静默」+ safer corrupt FS case).
 * phase 705 自 foundation/claw-paths.ts 迁入 L4.ClawTopology。
 */
export function enumerateClaws(fs: FileSystem, clawsDir: string): string[] {
  return fs
    .listSync(clawsDir, { includeDirs: true })
    .filter(e => e.isDirectory)
    .map(e => e.name);
}

/**
 * phase 705: 为 L2c Messaging.notifyClaw 计算 caller 注入所需路径。
 * L4 ClawTopology 持有 chestnut 目录布局知识；Messaging 仅负责 inbox 写入协议。
 */
export function routeNotifyClaw(
  fs: FileSystem,
  chestnutRoot: string,
  motionClawId: string,
  targetClawId: string,
  message: InboxMessageOptionsBase,
  audit: AuditLog,
): void {
  const isMotion = targetClawId === motionClawId;
  const targetClawRoot = isMotion
    ? path.join(chestnutRoot, motionClawId)
    : path.join(chestnutRoot, CLAWS_DIR, targetClawId);
  const targetInboxDir = path.join(targetClawRoot, INBOX_PENDING_DIR);
  const dlqDir = isMotion ? undefined : path.join(chestnutRoot, motionClawId, 'inbox', 'dead-letter');
  notifyClaw(fs, targetClawRoot, targetInboxDir, dlqDir, message, audit);
}
