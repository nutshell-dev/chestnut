import type { CronJob } from '../../../foundation/cron/runner.js';
import { parseSchedule } from '../../../foundation/cron/runner.js';
import type { CronJobGlobalConfig } from '../../../foundation/cron/runner.js';
import type { MemorySystem } from '../index.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * dream-trigger 是 MemorySystem 暴露给 cron 框架的 trigger factory、
 * 业务执行体（runDeepDream + runRandomDream）归 MemorySystem。
 * phase 237 物理迁出 cron/jobs/（per drift-backlog B.phase197-cron-jobs-业务归属未彻底分散 升档 (a)）。
 */
export const DREAM_TRIGGER_CRON_TIMEOUT_MS = 30 * 60_000;  // 30 min

export interface DreamTriggerJobDeps {
  memorySystem: MemorySystem;
}

export function createDreamTriggerJob(
  deps: DreamTriggerJobDeps,
  globalConfig: CronJobGlobalConfig<'dream_trigger'>,
): CronJob {
  return {
    name: 'dream-trigger',
    enabled: globalConfig.cron.jobs.dream_trigger.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.dream_trigger.schedule),
    handler: async (signal) => {
      if (!deps.memorySystem) return;
      await deps.memorySystem.runDeepDream(undefined, { signal });
      await deps.memorySystem.runRandomDream({ signal });
    },
    timeoutMs: DREAM_TRIGGER_CRON_TIMEOUT_MS,
  };
}
