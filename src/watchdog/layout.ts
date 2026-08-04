/**
 * @module L6.Watchdog.Layout
 * @layer L6 进程边界（Watchdog 守护进程）
 * @depends 无（纯静态常量协议，零 import、零 IO）
 * @contract Phase 1286 Watchdog 磁盘资源命名空间最终布局
 *
 * Watchdog 磁盘布局唯一 owner（Phase 1287 Step B）：
 *   WATCHDOG_PATHS        目标布局 identity（应然路径，不代表资源已迁移）
 *   WATCHDOG_LEGACY_PATHS legacy 输入位置（仅未来 migration/compat 代码可消费）
 *
 * 边界：
 * - 路径值存在于 WATCHDOG_PATHS 不等于对应资源已发布；config/state/log/
 *   subscriptions 的生产 IO 切换必须带各自迁移协议，由独立 Phase 完成。
 * - 普通新写代码不得使用 WATCHDOG_LEGACY_PATHS。
 * - ownership 记录文件名（owner.json/outcome.json/terminal.json）归
 *   ownership 协议，不在此表。
 * - 本模块不执行任何初始化；禁止 import FileSystem / YAML / AuditLog /
 *   Assembly / CLI。
 */

/** layout.json 未来记录格式的版本身份；本 Phase 不创建或读写该文件。 */
export const WATCHDOG_LAYOUT_SCHEMA_VERSION = 1;

/** 目标布局（Phase 1286 最终树逐项一致）。 */
export const WATCHDOG_PATHS = {
  root: 'watchdog',
  layout: 'watchdog/layout.json',
  config: 'watchdog/config.yaml',
  state: 'watchdog/state.json',
  log: 'watchdog/watchdog.log',
  subscriptions: 'watchdog/subscriptions',
  candidates: 'watchdog/candidates',
  active: 'watchdog/active',
  retired: 'watchdog/retired',
  quarantine: 'watchdog/quarantine',
  migrations: 'watchdog/migrations',
} as const;

/** legacy 输入位置；仅允许未来 migration/compat 代码消费。 */
export const WATCHDOG_LEGACY_PATHS = {
  state: 'watchdog-state.json',
  subscriptions: 'watchdog-subscriptions',
  log: 'logs/watchdog.log',
  pid: 'watchdog.pid',
} as const;
