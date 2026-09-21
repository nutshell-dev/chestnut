/**
 * @module L6.Watchdog.Layout
 * @layer L6 进程边界（Watchdog 守护进程）
 * @depends 无（纯静态常量协议，零 import、零 IO）
 * @contract Phase 1286 Watchdog 磁盘资源命名空间最终布局
 *
 * Watchdog 磁盘布局唯一 owner（Phase 1287 Step B）：
 *   WATCHDOG_PATHS        目标布局 identity
 *
 * 边界：
 * - 全部资源生产 IO 走 WATCHDOG_PATHS；subscriptions 0 生产使用（退役登记）。
 *   （phase 1890 Step J：WATCHDOG_LEGACY_PATHS 随迁移协议退役删除——无老版本
 *   部署存量；legacy 输入位置不再特设。）
 * - ownership 记录文件名（owner.json/outcome.json/terminal.json）归
 *   ownership 协议，不在此表。
 * - 本模块不执行任何初始化；禁止 import FileSystem / YAML / AuditLog /
 *   Assembly / CLI。
 */

/** layout.json 记录格式的版本身份（同时是 watchdog/config.yaml 的 schema_version）。 */
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
} as const;
