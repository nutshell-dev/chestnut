/**
 * Shared path constants + runtime path resolution — system-level directory
 * structure convention (M#3 single owner).
 *
 * foundation/paths.ts is the canonical location for all path knowledge.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import type { FileSystem } from './fs/types.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, OUTBOX_PENDING_DIR } from './messaging/dirs.js';


// ── Path constants ──

export const CLAWS_DIR = 'claws' as const;
export const CLAWSPACE_DIR = 'clawspace' as const;

/** dispatch-skills 子目录名（path segment / 与 CLAWSPACE_DIR 拼接 / phase 1354 r-phase1354 物理迁自 core/evolution-system/dispatch-skills-paths.ts、切 evolution↔summon 2-cycle）*/
export const DISPATCH_SKILLS_SUBDIR = 'dispatch-skills' as const;

/** dispatch-skills 完整相对路径（caller 自取 motionBaseDir + 本路径）*/
export const DISPATCH_SKILLS_PATH = `${CLAWSPACE_DIR}/${DISPATCH_SKILLS_SUBDIR}` as const;

export const CLAW_SUBDIRS = [
  'dialog',
  'dialog/archive',
  INBOX_PENDING_DIR,
  INBOX_DONE_DIR,
  INBOX_FAILED_DIR,
  OUTBOX_PENDING_DIR,
  'outbox/done',
  'outbox/failed',
  'tasks/queues/pending',
  'tasks/queues/running',
  'tasks/queues/done',
  'tasks/queues/failed',
  'tasks/queues/results',
  'tasks/sync/exec',
  'tasks/sync/write',
  'tasks/sync/search',
  'tasks/sync/subagent',
  'tasks/sync/spawn',
  'tasks/sync/shadow',
  'tasks/subagents',
  'memory',
  'contract',
  'skills',
  CLAWSPACE_DIR,
  'logs',
  'status',
] as const;

// ── Runtime path resolution ──

/** Workspace root — prefers CLAWFORUM_ROOT env var (inherited by exec child processes). */
export function getWorkspaceRoot(): string {
  return process.env.CLAWFORUM_ROOT ?? process.cwd();
}

export function getGlobalConfigPath(): string {
  return path.join(getWorkspaceRoot(), '.clawforum', 'config.yaml');
}

/**
 * Validate identifier-class param (clawId / skillName / etc) against traversal.
 * @throws Error if name contains '/', '..', is empty, '.' or starts with '.'.
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

import { type ClawDir, makeClawDir } from './identity/index.js';

export function getClawDir(name: string): ClawDir {
  assertSafeClawId(name);
  return makeClawDir(path.join(getWorkspaceRoot(), '.clawforum', 'claws', name));
}

export function getClawforumRoot(): string {
  return path.join(getWorkspaceRoot(), '.clawforum');
}

/**
 * Generic helper to get a named subroot dir under .clawforum/.
 * Caller side owns the name (e.g., motion reserved name).
 *
 * @param name - subroot name (caller-owned, e.g., motion, claws)
 * @returns path joined under workspaceRoot/.clawforum/<name>
 */
export function getNamedSubrootDir(name: string): string {
  return path.join(getWorkspaceRoot(), '.clawforum', name);
}

export function getClawConfigPath(name: string): string {
  return path.join(getClawDir(name), 'config.yaml');
}


// ── spawn 入口路径解析（M#1 单一权威 / phase 1436）──
//
// bundled 输出：tsup code-split 将所有 chunk（含本 helper）平铺至 dist/，
// daemon-entry.js / watchdog-entry.js 与之同处 dist/ 顶层 → PATHS_THIS_DIR = dist/。
// unbundled / dev：thisDir = dist/foundation/（tsc 保 src 层级），entry 至 dist 根，
// 上溯 1 级 → PATHS_THIS_DIR basename = 'foundation'。
//
// 模式判别：basename 比较纯路径结构、无 fs 依赖（ML#3 fs 归 foundation/fs/、
// paths.ts 是 L1 路径层不应直 import node:fs）。
//
// 散落历史：phase 1436 前 7 cli/commands + 1 watchdog 共 8 caller 各自手算路径，
// 3 种 fallback 层数 + 2 种 exists 判定 = 6 种写法。tsup code-split 平铺策略一改
// 即全炸（toolprotocol-rechecker / messaging-auditor / tools-auditor daemon spawn
// MODULE_NOT_FOUND 实证）。
//
// signature 保 `(_fs?: FileSystem)`：caller 调用形式与既有 `existsSync` 风格一致、
// 未来若 entry 路径源迁回 user fs（罕见）签名不破。当前实现不消费 fs 参数（路径
// 结构自决）。

const PATHS_THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PATHS_IS_BUNDLED = path.basename(PATHS_THIS_DIR) !== 'foundation';

export function resolveDaemonEntry(_fs?: FileSystem): string {
  return resolveSpawnEntry('daemon-entry.js');
}

export function resolveWatchdogEntry(_fs?: FileSystem): string {
  return resolveSpawnEntry('watchdog-entry.js');
}

function resolveSpawnEntry(filename: string): string {
  if (PATHS_IS_BUNDLED) return path.join(PATHS_THIS_DIR, filename);
  return path.resolve(PATHS_THIS_DIR, '..', filename);
}
