import * as path from 'path';
import { formatErr } from "../../../foundation/utils/index.js";
import { exec } from '../../../foundation/process-exec/index.js';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ClawTopology } from '../../../core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../../claw-topology/index.js';
import { GIT_GC_WEEKLY_AUDIT_EVENTS } from './git-gc-weekly-audit-events.js';
import type { CronJob } from '../runner.js';
import { parseSchedule } from '../runner.js';
import type { CronJobGlobalConfig } from '../runner.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per M#2 模块为自己业务语义负责).
 */
export const GIT_GC_WEEKLY_CRON_TIMEOUT_MS = 120_000;

export interface GitGcWeeklyOptions {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  fs: FileSystem;
  audit: AuditLog;
  signal?: AbortSignal;
}

export interface GitGcWeeklyJobDeps {
  clawTopology: ClawTopology;
  fs: FileSystem;
  audit: AuditLog;
}

export async function runGitGcWeekly(opts: GitGcWeeklyOptions): Promise<void> {
  const { clawTopology, fs, audit } = opts;

  const clawIds = clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID);
  for (const clawId of clawIds) {
    if (opts.signal?.aborted) return;
    const location = clawTopology.resolve(clawId);
    if (location.kind !== 'local') continue;
    const gitDir = path.join(location.clawDir, '.git');
    if (!fs.existsSync(gitDir)) continue;
    try {
      await exec('git', ['gc', '--auto'], { cwd: location.clawDir });
    } catch (err) {
      audit.write(
        GIT_GC_WEEKLY_AUDIT_EVENTS.GIT_GC_WEEKLY_CLAW_FAILED,
        `claw=${clawId}`,
        `error=${formatErr(err)}`,
      );
    }
  }

  audit.write(
    GIT_GC_WEEKLY_AUDIT_EVENTS.GIT_GC_WEEKLY_COMPLETED,
    `claws=${clawIds.length}`,
  );
}

export function createGitGcWeeklyJob(
  deps: GitGcWeeklyJobDeps,
  globalConfig: CronJobGlobalConfig<'git_gc_weekly'>,
): CronJob {
  return {
    name: 'git-gc-weekly',
    enabled: globalConfig.cron.jobs.git_gc_weekly.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.git_gc_weekly.schedule, deps.audit),
    handler: (signal) => runGitGcWeekly({ ...deps, signal }),
    timeoutMs: GIT_GC_WEEKLY_CRON_TIMEOUT_MS,
  };
}
