/**
 * @module L6.Watchdog.Context
 * Module-level singleton state for watchdog daemon.
 *
 * Phase 1396 Step H: retired crash/inactivity/subscription cron state; only
 * motion restart and executor restart durable state remain.
 */

import * as path from 'path';
import { resolveWatchdogEntry } from './entry-resolver.js';
import { getNamedSubrootDir } from '../core/claw-topology/index.js';
import { readWorkspaceWatchdogConfig } from './workspace-config.js';
import type { WatchdogConfig } from './config-schema.js';
import type { FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { createDirContext } from '../foundation/audit/index.js';

export type MotionRestartState =
  | {
      status: 'closed';
      consecutiveAttempts: 0;
    }
  | {
      status: 'retrying';
      consecutiveAttempts: number;
      nextAttemptAt: number;
      awaitingStability: boolean;
    }
  | {
      status: 'open';
      consecutiveAttempts: number;
      openedAt: number;
    };

const CLOSED_MOTION_RESTART_STATE: MotionRestartState = {
  status: 'closed',
  consecutiveAttempts: 0,
};

let _motionRestartState: MotionRestartState = { ...CLOSED_MOTION_RESTART_STATE };

export const motionRestartStateAPI = {
  snapshot(): MotionRestartState {
    return { ..._motionRestartState };
  },
  replace(state: MotionRestartState): void {
    _motionRestartState = { ...state };
  },
  reset(): void {
    _motionRestartState = { ...CLOSED_MOTION_RESTART_STATE };
  },
} as const;

// Phase 1396 Step F: per-claw executor restart durable state (mirrors motionRestartStateAPI)
export type ExecutorRestartState =
  | { status: 'closed'; consecutiveAttempts: 0 }
  | { status: 'retrying'; consecutiveAttempts: number; nextAttemptAt: number; awaitingStability: boolean }
  | { status: 'open'; consecutiveAttempts: number; openedAt: number; sinkDelivered?: boolean };

export type ExecutorRestartMap = Record<string, ExecutorRestartState>;

const EMPTY_EXECUTOR_RESTART_MAP: ExecutorRestartMap = {};

let _executorRestartMap: ExecutorRestartMap = { ...EMPTY_EXECUTOR_RESTART_MAP };

export const executorRestartStateAPI = {
  snapshot(): ExecutorRestartMap {
    return { ..._executorRestartMap };
  },
  replace(state: ExecutorRestartMap): void {
    _executorRestartMap = { ...state };
  },
  reset(): void {
    _executorRestartMap = { ...EMPTY_EXECUTOR_RESTART_MAP };
  },
} as const;

// === Lazy cache state（封装 / 经 getter） ===

let _motionCtx: { fs: FileSystem; audit: AuditLog } | null = null;
let _chestnutFs: FileSystem | null = null;
let _chestnutFsBaseDir: string | null = null;
let watchdogConfigCache: WatchdogConfig | null = null;
let _auditWriter: AuditLog | null = null;

/** 1:1 保 watchdog.ts:29-31 */
export function getChestnutDir(): string {
  return path.dirname(getNamedSubrootDir('motion'));
}

/**
 * Returns the absolute path to the watchdog entry script for this installation.
 * Used as the pgrep pattern to scope process operations to the current install.
 */
export function getWatchdogEntryPath(): string {
  return resolveWatchdogEntry();
}

// motion audit 归属：watchdog 对 motion 的观察事件（inbox 通知 / crash 通知）
// 命名契约：内部可变变量 `_motionCtx`（下划线前缀 = 模块私有），外部访问仅经 `getMotionContext()`
// 唯一管理者：watchdog.ts 模块；进程级单例，lazy init
/** 1:1 保 watchdog.ts:58-67 */
export function getMotionContext(fsFactory: (baseDir: string) => FileSystem): { fs: FileSystem; audit: AuditLog } {
  if (!_motionCtx) {
    _motionCtx = createDirContext({ fsFactory }, getNamedSubrootDir('motion'));
    // 失败契约（fail-fast）：createDirContext 抛错 → 直接上抛
    //   - _motionCtx 保持 null，调用方（watchdog 主循环）整个 iteration 失败
    //   - 不做 catch 重建、不降级写 stdout；watchdog 进程应由 SIGTERM 或 uncaughtException 兜底
    //   - 理由：motion audit 写入失败属基础设施损坏，静默继续会丢观察事件（违反"信息不丢失"）
  }
  return _motionCtx;
}

// chestnut FileSystem lazy singleton（mirror getMotionContext 模式）
// 增加 baseDir 缓存校验，使测试环境在 getChestnutDir() 变化时自动重建实例
/** 1:1 保 watchdog.ts:73-80 */
export function getChestnutFs(fsFactory: (baseDir: string) => FileSystem): FileSystem {
  const baseDir = getChestnutDir();
  if (!_chestnutFs || _chestnutFsBaseDir !== baseDir) {
    _chestnutFs = fsFactory(baseDir);
    _chestnutFsBaseDir = baseDir;
  }
  return _chestnutFs;
}

// Watchdog 自家 workspace config（Phase 1289 Step C：监控参数消费自 Assembly global config
// 切换至 .chestnut/watchdog/config.yaml；lazy load on first access）
// 失败契约：missing/invalid 由 readWorkspaceWatchdogConfig throw fail-loud
//   （不回退 root YAML、不静默默认），上抛；cache 保持 null，下 tick 重试
/** 1:1 保 watchdog.ts:252-257 */
export function getWatchdogConfig(fsFactory: (baseDir: string) => FileSystem): WatchdogConfig {
  if (!watchdogConfigCache) {
    watchdogConfigCache = readWorkspaceWatchdogConfig(getChestnutFs(fsFactory));
  }
  return watchdogConfigCache;
}

/** 1:1 保 watchdog.ts:260-262 */
export function setAuditWriter(auditWriter: AuditLog | null): void {
  _auditWriter = auditWriter;
}

/** Reader for sub-file（log / state / cli）*/
export function getAuditWriter(): AuditLog | null {
  return _auditWriter;
}

/**
 * Test-only: reset all module-level state.
 */
export function _resetWatchdogContextForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetWatchdogContextForTest is for tests only');
  }
  // lazy caches
  _motionCtx = null;
  _chestnutFs = null;
  _chestnutFsBaseDir = null;
  watchdogConfigCache = null;
  _auditWriter = null;
  // durable state
  _motionRestartState = { ...CLOSED_MOTION_RESTART_STATE };
  _executorRestartMap = { ...EMPTY_EXECUTOR_RESTART_MAP };
}
