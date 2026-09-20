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
 */
import { z } from 'zod';
import { WATCHDOG_LAYOUT_SCHEMA_VERSION } from './layout.js';
import { WATCHDOG_INTERVAL_MS, HEARTBEAT_STALE_TIMEOUT_MS } from './constants.js';

/**
 * Phase 1878 Step C：config 面与消费面对齐——只保留当前 Watchdog 消费的参数。
 * `disk_warning_mb` / `claw_inactivity_timeout_ms` 已退役（零生产决策消费）：
 * schema 不再声明，旧持久文件/legacy 段中的同名字段由 zod 静默剥离（视作已退役、
 * 不报错；迁移 journal retired_fields 显式留证，见 config-load.ts）。
 */
export const watchdogConfigSchema = z.object({
  interval_ms: z.number().min(5000).default(WATCHDOG_INTERVAL_MS),
  /**
   * alive-but-loop-stale 判定阈值（Phase 1878 Step B 心跳监督消费）。
   * Derivation: min 60_000 = daemon liveness tick（60s，daemon-loop
   * LIVENESS_HEARTBEAT_MS）——低于 1 tick 时 daemon 来不及刷新心跳必误判；
   * 默认 180_000 = 3 × tick（HEARTBEAT_STALE_TIMEOUT_MS derivation 见 constants.ts）。
   */
  heartbeat_stale_timeout_ms: z.number().min(60000).default(HEARTBEAT_STALE_TIMEOUT_MS),
});

export type WatchdogConfig = z.infer<typeof watchdogConfigSchema>;

/**
 * .chestnut/watchdog/config.yaml 落盘文件 schema：业务 config + 文件版本。
 * 磁盘形态（Phase 1289 总览拍板；Phase 1878 Step C 字段对齐）：
 *   schema_version: 1
 *   interval_ms: 30000
 *   heartbeat_stale_timeout_ms: 180000
 * 未知未来 schema_version → invalid（fail-closed，z.literal 校验天然满足）。
 * 旧文件含已退役字段（disk_warning_mb / claw_inactivity_timeout_ms）→ zod 静默
 * 剥离、读取不报错（显式退役语义）。
 */
export const watchdogWorkspaceConfigFileSchema = watchdogConfigSchema.extend({
  schema_version: z.literal(WATCHDOG_LAYOUT_SCHEMA_VERSION),
});

type WatchdogWorkspaceConfigFile = z.infer<typeof watchdogWorkspaceConfigFileSchema>;

/** fresh init 默认 workspace watchdog config（只有 fresh init 才允许创建默认配置）。 */
export function createDefaultWatchdogWorkspaceConfig(): WatchdogWorkspaceConfigFile {
  return {
    schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    interval_ms: WATCHDOG_INTERVAL_MS,
    heartbeat_stale_timeout_ms: HEARTBEAT_STALE_TIMEOUT_MS,
  };
}
