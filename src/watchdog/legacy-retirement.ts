/**
 * @module L6.Watchdog.LegacyRetirement
 * @layer L6 进程边界（Watchdog 守护进程）
 *
 * Phase 1455 Step C: legacy 磁盘资源清退 owner 原语。
 *
 * 前提（Step C §4.2 硬约束——清退不早于迁移验证）：
 * - state：迁移 outcome 已回读验证落盘（编排层保证时序）；
 * - log：写路径已于 Step B 切至 WATCHDOG_PATHS.log，legacy 日志是纯历史
 *   （追加快照、不重放）——按 Step C §4.2 拍板删除、不归档（audit.tsv 是
 *   结构化留痕，stdout 已有同文）；
 * - subscriptions：0 生产使用（2026-08-21 grep 实核 + 本 Step 复核）、无数据
 *   迁移、目录整体清退。
 *
 * 全部幂等（存在才删）；本模块只提供原语、不编排（编排见
 * cli/watchdog-state-migration.ts 的迁移终态收口）。
 * fs 一律以 chestnutRoot 为 baseDir；路径全部出自 ./layout.js。
 */
import type { FileSystem } from '../foundation/fs/index.js';
import { WATCHDOG_LEGACY_PATHS } from './layout.js';

function retireFile(fs: FileSystem, path: string): boolean {
  if (!fs.existsSync(path)) return false;
  fs.deleteSync(path);
  return true;
}

export function createWatchdogLegacyRetirement(fs: FileSystem) {
  return {
    /** 清退 root `watchdog-state.json`；返回是否实际删除。 */
    retireLegacyState: (): boolean => retireFile(fs, WATCHDOG_LEGACY_PATHS.state),
    /** 清退 `logs/watchdog.log`（历史日志、删除不归档）；返回是否实际删除。 */
    retireLegacyLog: (): boolean => retireFile(fs, WATCHDOG_LEGACY_PATHS.log),
    /** 清退 `watchdog-subscriptions/`（0 生产使用、目录整体递归删除）；返回是否实际删除。 */
    retireLegacySubscriptions: (): boolean => {
      if (!fs.existsSync(WATCHDOG_LEGACY_PATHS.subscriptions)) return false;
      fs.removeDirSync(WATCHDOG_LEGACY_PATHS.subscriptions);
      return true;
    },
  } as const;
}

export type WatchdogLegacyRetirement = ReturnType<typeof createWatchdogLegacyRetirement>;
