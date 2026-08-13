/**
 * @module L6.Watchdog
 * @layer L6 进程边界（Watchdog 工具函数）
 * @depends L1.FileSystem, L2.AuditLog
 * @consumers L6.Watchdog
 * @contract design/modules/l6_watchdog.md
 *
 * Watchdog 工具函数 — 提取以便测试。
 *
 * phase 1383 (P2b): inactivity/subscription 相关工具退场——
 * getClawActivityInfo / gatherClawSnapshot / deriveFailureClass /
 * formatInactivityBody / getEffectiveInterval / shouldResetNotifyCount 删除
 * （停滞自活归 daemon 内化、不再由 Watchdog 观察 stream 活动）。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { type AuditLog } from '../foundation/audit/index.js';
import { hasActiveContract } from '../core/contract/index.js';

/**
 * Watchdog daemon restart exponential backoff cap（ms）= 5 minutes.
 * Derivation: 5 * 60 * 1000 = 300_000ms / 配 WATCHDOG_MAX_RESTART_DEFAULT=10 即最坏总 retry budget
 * = 10 × 5min = 50min / 与 LLM_RETRY_MAX_DELAY_MS=300s 同值同类 cap exponential backoff /
 * 防无限退避致 daemon 永挂 unrecoverable. Phase 1380: 从 watchdog.ts 迁入（防 cron→watchdog.ts 循环依赖）。
 */
export const WATCHDOG_BACKOFF_MAX_MS = 5 * 60 * 1000;

/**
 * 连续 daemon restart 失败 cap、触顶进 circuit-open（phase 324 H3 立 / phase 1380 迁入）。
 * Derivation: 10 次重启失败后表程序态严重问题、继续重启浪费资源 /
 * 配 WATCHDOG_BACKOFF_MAX_MS=5min 即 10 × 5min = 50min 总 retry budget /
 * env WATCHDOG_MAX_RESTART 设有效正整数时覆盖.
 */
const WATCHDOG_MAX_RESTART_DEFAULT = 10;
export function getWatchdogMaxRestart(): number {
  const raw = process.env.WATCHDOG_MAX_RESTART;
  if (!raw) return WATCHDOG_MAX_RESTART_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : WATCHDOG_MAX_RESTART_DEFAULT;
}

// phase 1123 Step D: crash detection considers only ACTIVE contracts.
// Legacy paused contracts are observed via ContractSystem.findLegacyPausedContracts, not here.

// phase 1482: Check if a claw has an ACTIVE contract only.
// crash 检测唯一消费者（dead + active contract 才重启）。
export function clawHasActiveContract(clawDir: string, fsFactory: (baseDir: string) => FileSystem, _audit?: AuditLog): boolean {
  const fs = fsFactory(clawDir);
  return hasActiveContract(fs, '.');
}

// ---- phase 2 γ4: claw_crashed CrashClass taxonomy ----

/**
 * Crash class for `claw_crashed` watchdog notification.
 * 业主 own enum、由 clean-stop marker 探测决定。
 *
 * - `active_unexpected`: active contract + daemon dead + 无 clean-stop marker → 重启 daemon
 * - `active_user_stopped`: active contract + daemon dead + 有 clean-stop marker (user/system 主动 stop) → motion 知情即可
 *
 * Legacy paused contracts are not considered crashes (caller must guard with clawHasActiveContract).
 * Assembly motion guidance composer type-only import 此 enum、按 class switch.
 */
export type { CrashClass } from './claw-failure-classes.js';
import type { CrashClass } from './claw-failure-classes.js';

export interface DeriveCrashClassInput {
  hasCleanStopMarker: boolean;
}

export function deriveCrashClass(input: DeriveCrashClassInput): CrashClass {
  return input.hasCleanStopMarker ? 'active_user_stopped' : 'active_unexpected';
}

/** 读 `<clawDir>/clean-stop` marker 存在判定 (read-only / 不消费 marker / phase 1373 sub-3 + phase 2 γ4 per-claw 扩). */
export function hasCleanStopMarker(clawDir: string, fsFactory: (baseDir: string) => FileSystem): boolean {
  try {
    const fs = fsFactory(clawDir);
    return fs.existsSync('clean-stop');
  } catch {
    return false;
  }
}

/** Body 字面 (phase 4 重写): per-class 自含语义、不附 raw audit events (避免 motion 误以为线索仅此 / 改让 composer 教 diagnostic CLI). */
export function formatCrashBody(opts: {
  clawId: string;
  crashClass: CrashClass;
  contract: string;
}): string {
  switch (opts.crashClass) {
    case 'active_unexpected':
      return `Claw "${opts.clawId}" crashed unexpectedly while running contract ${opts.contract}.`;
    case 'active_user_stopped':
      return `Claw "${opts.clawId}" was stopped via CLI while running contract ${opts.contract}.`;
    default: {
      const _exhaustive: never = opts.crashClass;
      return _exhaustive;
    }
  }
}
