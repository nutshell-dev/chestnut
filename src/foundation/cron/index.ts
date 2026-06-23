/**
 * @module L2a.Cron
 * Cron module exports
 *
 * phase 695 重分类：L5 服务 → L2a 通用基础设施。
 * Cron 0 chestnut business deps (runner.ts: AuditLog + utils only)、
 * 0 own process (装在 motion daemon 内组件、同 Snapshot / ProcessManager 模式)、
 * 与 ProcessManager / Snapshot / AuditLog 同型 = L2a 通用基础设施。
 * 原 L5 分类是 architecture.md L5 行把「定时调度」纳入造成的应然描述错位。
 * 注：cron/jobs/* 子目录的 @module L5.Cron.* 暂留（层 2 cluster pending、
 * jobs 物理迁出到各业务 owner 模块时统一改）。
 */

import { CronRunner } from './runner.js';
import type { CronJob } from './runner.js';
import type { AuditLog } from '../../foundation/audit/index.js';

export { CronRunner, parseSchedule } from './runner.js';
export type { CronSchedule, CronJob } from './runner.js';

/**
 * 构造 CronRunner。
 * 调用方必须在使用前显式 `runner.start(tickMs)` 启动 setInterval（契约 §2.1）。
 */
export function createCronRunner(jobs: CronJob[], audit: AuditLog): CronRunner {
  return new CronRunner(jobs, audit);
}
