/**
 * @module L4.ContractSystem.ExecutorSupervisor
 * Phase 1974 Step B: ContractSystem executor-supervisor cron job 工厂。
 *
 * 业务：有已发布 active contract 的 claw，其 executor daemon 由系统自动确保运行
 * （motion cron 事件驱动；不新增 agent prompt/上下文负担）。
 * 归属：ContractSystem jobs（拥有 active contract 事实）；daemon 进程生命周期仍归
 * ProcessManager/Daemon（经装配期注入的窄能力消费，不 import 实现）。
 *
 * Design: design/modules/l4_contract_system.md（Phase 1974 职责注记）
 */
import type { CronJob } from '../../../../foundation/cron/index.js';
import { parseSchedule } from '../../../../foundation/cron/index.js';
import type { CronJobGlobalConfig } from '../../../../foundation/cron/index.js';
import { runExecutorSupervisorTick } from './tick.js';
import type { ExecutorSupervisorDeps } from './types.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick。
 * ensureRunning 含 spawn + ready 收敛等待（BOOT_DEADLINE 量级），5min 充裕。
 * 由本 module 业务自决 (per M#2 模块为自己业务语义负责)。
 */
export const EXECUTOR_SUPERVISOR_CRON_TIMEOUT_MS = 5 * 60_000;

export function createExecutorSupervisorJob(
  deps: ExecutorSupervisorDeps,
  globalConfig: CronJobGlobalConfig<'executor_supervisor'>,
): CronJob {
  return {
    name: 'executor-supervisor',
    enabled: globalConfig.cron.jobs.executor_supervisor.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.executor_supervisor.schedule, deps.audit),
    handler: (signal) => runExecutorSupervisorTick({ ...deps, signal }),
    timeoutMs: EXECUTOR_SUPERVISOR_CRON_TIMEOUT_MS,
  };
}
