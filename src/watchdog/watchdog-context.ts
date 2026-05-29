/**
 * @module L6.Watchdog.Context
 * Module-level singleton state for watchdog daemon
 *
 * 5 lazy cache（_motionCtx / _clawforumFs / globalConfigCache / _auditWriter）
 * + 3 Map（cron 状态：lastInactivityNotified / clawPreviouslyAlive / inactivityNotifyCount）
 *
 * ESM live binding 保跨 sub-file 同实例（const Map reference 跨 file 共享 / let 经 getter/setter）
 */

import * as path from 'path';
import { resolveWatchdogEntry } from '../foundation/paths.js';
import { getNamedSubrootDir, loadGlobalConfig } from '../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../assembly/index.js';
import type { FileSystem } from '../foundation/fs/types.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { createDirContext } from '../foundation/audit/index.js';
import { makeClawDir } from '../foundation/identity/index.js';

// === 共享 Map（cron state）/ ESM const reference 跨 file 同实例 ===

/** 1:1 保 watchdog.ts:194 */
export const lastInactivityNotified: Map<string, number> = new Map();

/** 1:1 保 watchdog.ts:195 */
export const clawPreviouslyAlive: Map<string, boolean> = new Map();

/** 1:1 保 watchdog.ts:196 */
export const inactivityNotifyCount: Map<string, number> = new Map();

/** Track claws that have ever been alive for first-tick crash detection (phase 1047) */
export const everSpawned: Set<string> = new Set();

/** Track claws for which crash_notification has already been emitted (phase 1207 dedup)
 *  phase 1269: persist to state (Map<string, notified_ts_ms>)
 */
export const clawPreviouslyNotified: Map<string, number> = new Map();

// === Lazy cache state（封装 / 经 getter） ===

let _motionCtx: { fs: FileSystem; audit: AuditLog } | null = null;
let _clawforumFs: FileSystem | null = null;
let _clawforumFsBaseDir: string | null = null;
let globalConfigCache: ReturnType<typeof loadGlobalConfig> | null = null;
let _auditWriter: AuditLog | null = null;

/** 1:1 保 watchdog.ts:29-31 */
export function getClawforumDir(): string {
  return path.dirname(makeClawDir(getNamedSubrootDir('motion')));
}

/**
 * Returns the absolute path to the watchdog entry script for this installation.
 * Used as the pgrep pattern to scope process operations to the current install.
 */
export function getWatchdogEntryPath(fsFactory: (baseDir: string) => FileSystem): string {
  return resolveWatchdogEntry(fsFactory(process.cwd()));
}

// motion audit 归属：watchdog 对 motion 的观察事件（inbox 通知 / crash 通知）
// 命名契约：内部可变变量 `_motionCtx`（下划线前缀 = 模块私有），外部访问仅经 `getMotionContext()`
// 唯一管理者：watchdog.ts 模块；进程级单例，lazy init
/** 1:1 保 watchdog.ts:58-67 */
export function getMotionContext(fsFactory: (baseDir: string) => FileSystem): { fs: FileSystem; audit: AuditLog } {
  if (!_motionCtx) {
    _motionCtx = createDirContext({ fsFactory }, makeClawDir(getNamedSubrootDir('motion')));
    // 失败契约（fail-fast）：createDirContext 抛错 → 直接上抛
    //   - _motionCtx 保持 null，调用方（watchdog 主循环）整个 iteration 失败
    //   - 不做 catch 重建、不降级写 stdout；watchdog 进程应由 SIGTERM 或 uncaughtException 兜底
    //   - 理由：motion audit 写入失败属基础设施损坏，静默继续会丢观察事件（违反"信息不丢失"）
  }
  return _motionCtx;
}

// clawforum FileSystem lazy singleton（mirror getMotionContext 模式）
// 增加 baseDir 缓存校验，使测试环境在 getClawforumDir() 变化时自动重建实例
/** 1:1 保 watchdog.ts:73-80 */
export function getClawforumFs(fsFactory: (baseDir: string) => FileSystem): FileSystem {
  const baseDir = getClawforumDir();
  if (!_clawforumFs || _clawforumFsBaseDir !== baseDir) {
    _clawforumFs = fsFactory(baseDir);
    _clawforumFsBaseDir = baseDir;
  }
  return _clawforumFs;
}

// Global config (loaded lazily on first access)
/** 1:1 保 watchdog.ts:252-257 */
export function getGlobalConfig(fsFactory: (baseDir: string) => FileSystem) {
  if (!globalConfigCache) {
    globalConfigCache = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
  }
  return globalConfigCache;
}

/** 1:1 保 watchdog.ts:260-262 */
export function setAuditWriter(auditWriter: AuditLog | null): void {
  _auditWriter = auditWriter;
}

/** Reader for sub-file（log / state / cron / cli）*/
export function getAuditWriter(): AuditLog | null {
  return _auditWriter;
}
