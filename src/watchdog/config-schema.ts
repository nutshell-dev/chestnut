/**
 * Watchdog config schema / phase 10 decentralize
 * Owner: watchdog（监控进程参数 yaml schema 业主）
 * Composed by: src/assembly/compose-config.ts (yaml `watchdog.*` field)
 *
 * Phase 1289 Step B: schema 开始服务于两处新场景（Assembly compose 本 Step 仍在用）：
 *   1. Watchdog 自家 config store（.chestnut/watchdog/config.yaml，见 workspace-config.ts）
 *   2. 迁移期 legacy root YAML `watchdog:` 段的 typed 读取（Assembly 代为 raw 读取后 parse；
 *      legacy 段可能含 log_archive_days 等退役字段，parse 时由 zod 静默剥离、
 *      由 Assembly 原语显式捕获进迁移 journal，见 config-load.ts）
 *
 * phase 1383 (P2b): claw_inactivity_timeout_ms 退场——停滞自活归 daemon 内化，
 * Watchdog 不再观察 claw 业务停滞。
 */
import { z } from 'zod';
import { WATCHDOG_LAYOUT_SCHEMA_VERSION } from './layout.js';
import {
  WATCHDOG_INTERVAL_MS,
  DEFAULT_DISK_WARNING_MB,
} from './constants.js';

export const watchdogConfigSchema = z.object({
  interval_ms: z.number().min(5000).default(WATCHDOG_INTERVAL_MS),
  disk_warning_mb: z.number().min(10).default(DEFAULT_DISK_WARNING_MB),
});

export type WatchdogConfig = z.infer<typeof watchdogConfigSchema>;

/**
 * .chestnut/watchdog/config.yaml 落盘文件 schema：业务 config + 文件版本。
 * 磁盘形态（Phase 1289 总览拍板）：
 *   schema_version: 1
 *   interval_ms: 30000
 *   disk_warning_mb: 500
 * 未知未来 schema_version → invalid（fail-closed，z.literal 校验天然满足）。
 */
export const watchdogWorkspaceConfigFileSchema = watchdogConfigSchema.extend({
  schema_version: z.literal(WATCHDOG_LAYOUT_SCHEMA_VERSION),
});

export type WatchdogWorkspaceConfigFile = z.infer<typeof watchdogWorkspaceConfigFileSchema>;

/** fresh init 默认 workspace watchdog config（只有 fresh init 才允许创建默认配置）。 */
export function createDefaultWatchdogWorkspaceConfig(): WatchdogWorkspaceConfigFile {
  return {
    schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    interval_ms: WATCHDOG_INTERVAL_MS,
    disk_warning_mb: DEFAULT_DISK_WARNING_MB,
  };
}
