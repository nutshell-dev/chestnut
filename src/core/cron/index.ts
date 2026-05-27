/**
 * @module L5.Cron
 * Cron module exports
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
