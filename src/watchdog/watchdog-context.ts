/**
 * @module L6.Watchdog.Context
 * Module-level singleton state for watchdog daemon
 *
 * 5 lazy cache（_motionCtx / _chestnutFs / globalConfigCache / _auditWriter）
 * + 3 Map（cron 状态：lastInactivityNotified / clawPreviouslyAlive / inactivityNotifyCount）
 *
 * ESM live binding 保跨 sub-file 同实例（const Map reference 跨 file 共享 / let 经 getter/setter）
 */

import * as path from 'path';
import { resolveWatchdogEntry } from '../assembly/spawn-entry.js';
import { getNamedSubrootDir, loadGlobalConfig } from '../foundation/config/index.js';
import type { FileSystem } from '../foundation/fs/types.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { createDirContext } from '../foundation/audit/index.js';

// === 内部 Map/Set（cron state）—— 通过 clawStateAPI 访问 ===

const _lastInactivityNotified = new Map<string, number>();
const _clawPreviouslyAlive = new Map<string, boolean>();
const _inactivityNotifyCount = new Map<string, number>();
const _everSpawned = new Set<string>();
const _clawPreviouslyNotified = new Map<string, number>();

interface MapStore<V> {
  get(k: string): V | undefined;
  set(k: string, v: V): void;
  has(k: string): boolean;
  delete(k: string): boolean;
  keys(): IterableIterator<string>;
  clear(): void;
  readonly size: number;
}

interface SetStore {
  add(k: string): void;
  has(k: string): boolean;
  delete(k: string): boolean;
  keys(): IterableIterator<string>;
  clear(): void;
  readonly size: number;
}

function mapStore<V>(m: Map<string, V>): MapStore<V> {
  return {
    get: (k) => m.get(k),
    set: (k, v) => { m.set(k, v); },
    has: (k) => m.has(k),
    delete: (k) => m.delete(k),
    keys: () => m.keys(),
    clear: () => m.clear(),
    get size() { return m.size; },
  };
}

function setStore(s: Set<string>): SetStore {
  return {
    add: (k) => { s.add(k); },
    has: (k) => s.has(k),
    delete: (k) => s.delete(k),
    keys: () => s.keys(),
    clear: () => s.clear(),
    get size() { return s.size; },
  };
}

export interface ClawStateSnapshot {
  lastInactivityNotified: Record<string, number>;
  clawPreviouslyAlive: Record<string, boolean>;
  inactivityNotifyCount: Record<string, number>;
  everSpawned: string[];
  clawPreviouslyNotified?: Record<string, number>;
}

export const clawStateAPI = {
  lastInactivityNotified: mapStore(_lastInactivityNotified),
  clawPreviouslyAlive: mapStore(_clawPreviouslyAlive),
  inactivityNotifyCount: mapStore(_inactivityNotifyCount),
  everSpawned: setStore(_everSpawned),
  clawPreviouslyNotified: mapStore(_clawPreviouslyNotified),

  snapshot(): ClawStateSnapshot {
    return {
      lastInactivityNotified: Object.fromEntries(_lastInactivityNotified),
      clawPreviouslyAlive: Object.fromEntries(_clawPreviouslyAlive),
      inactivityNotifyCount: Object.fromEntries(_inactivityNotifyCount),
      everSpawned: [..._everSpawned],
      clawPreviouslyNotified: Object.fromEntries(_clawPreviouslyNotified),
    };
  },

  replaceAll(s: ClawStateSnapshot): void {
    _lastInactivityNotified.clear();
    for (const [k, v] of Object.entries(s.lastInactivityNotified ?? {})) {
      _lastInactivityNotified.set(k, v);
    }

    _clawPreviouslyAlive.clear();
    for (const [k, v] of Object.entries(s.clawPreviouslyAlive ?? {})) {
      _clawPreviouslyAlive.set(k, v);
    }

    _inactivityNotifyCount.clear();
    for (const [k, v] of Object.entries(s.inactivityNotifyCount ?? {})) {
      _inactivityNotifyCount.set(k, v);
    }

    _everSpawned.clear();
    for (const id of s.everSpawned ?? []) {
      _everSpawned.add(id);
    }

    _clawPreviouslyNotified.clear();
    for (const [k, v] of Object.entries(s.clawPreviouslyNotified ?? {})) {
      _clawPreviouslyNotified.set(k, v);
    }
  },
} as const;

// === Lazy cache state（封装 / 经 getter） ===

let _motionCtx: { fs: FileSystem; audit: AuditLog } | null = null;
let _chestnutFs: FileSystem | null = null;
let _chestnutFsBaseDir: string | null = null;
let globalConfigCache: ReturnType<typeof loadGlobalConfig> | null = null;
let _auditWriter: AuditLog | null = null;

/** 1:1 保 watchdog.ts:29-31 */
export function getChestnutDir(): string {
  return path.dirname(getNamedSubrootDir('motion'));
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

// Global config (loaded lazily on first access)
/** 1:1 保 watchdog.ts:252-257 */
export function getGlobalConfig(fsFactory: (baseDir: string) => FileSystem) {
  if (!globalConfigCache) {
    globalConfigCache = loadGlobalConfig({ fsFactory });
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

/**
 * Test-only: reset all module-level state (mirrors `_resetDaemonSignalHandlers` /
 * `_resetShutdownGuard` patterns from daemon.ts / watchdog.ts).
 *
 * Phase 252: 16 watchdog-context-consuming test files previously self-managed
 * partial cleanup via scattered `setAuditWriter(null)` and `clawStateAPI.*.clear()`
 * calls in their afterEach blocks. That style is leak-prone — a single forgotten
 * call (or a new test file added without copying the dance) leaves stale
 * `_motionCtx` / `_chestnutFs` / `globalConfigCache` / `_auditWriter` / cron-state
 * Maps for the next test. This helper is a single-call replacement that resets
 * every module-level mutable surface deterministically.
 *
 * Call from beforeEach in every test file that imports any watchdog-context
 * export. The existing partial cleanup in afterEach blocks is intentionally
 * left in place as belt-and-suspenders.
 */
export function _resetWatchdogContextForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetWatchdogContextForTest is for tests only');
  }
  // 5 lazy caches
  _motionCtx = null;
  _chestnutFs = null;
  _chestnutFsBaseDir = null;
  globalConfigCache = null;
  _auditWriter = null;
  // 5 cron-state Maps/Sets
  _lastInactivityNotified.clear();
  _clawPreviouslyAlive.clear();
  _inactivityNotifyCount.clear();
  _everSpawned.clear();
  _clawPreviouslyNotified.clear();
}
