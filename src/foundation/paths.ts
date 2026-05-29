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
// bundled 输出：tsup code-split 将所有 chunk（含本 helper）平铺至 dist/、
// daemon-entry.js / watchdog-entry.js 与之同处 dist/ 顶层。
// unbundled / dev：thisDir = src/foundation/、entry 编译至 dist 根、上溯 1 级。
//
// 散落历史：phase 1436 前 7 cli/commands + 1 watchdog 共 8 caller 各自手算路径、
// 3 种 fallback 层数（0/1/2）+ 2 种 exists 判定（callerDir / cwd 相对）= 6 种写法。
// tsup code-split 平铺策略一改即全炸（toolprotocol-rechecker / messaging-auditor /
// tools-auditor daemon spawn MODULE_NOT_FOUND 实证）。

const PATHS_THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function resolveDaemonEntry(fs: FileSystem): string {
  return resolveSpawnEntry(fs, 'daemon-entry.js');
}

export function resolveWatchdogEntry(fs: FileSystem): string {
  return resolveSpawnEntry(fs, 'watchdog-entry.js');
}

function resolveSpawnEntry(fs: FileSystem, filename: string): string {
  // bundled 同处 dist/ 顶层。命中即返。
  const bundled = path.join(PATHS_THIS_DIR, filename);
  if (fs.existsSync(bundled)) return bundled;
  // unbundled / dev：上溯 1 级（src/foundation/ → src/）；
  // 也作 pgrep pattern 兜底：即使物理不存（test fixture 不落 dist）也返该字符串，
  // 由 caller spawn 时 node 报真 MODULE_NOT_FOUND，与 phase 1436 前同语义。
  return path.resolve(PATHS_THIS_DIR, '..', filename);
}
