import * as path from 'path';
import { formatErr } from "../../../foundation/utils/index.js";
import { exec } from '../../../foundation/process-exec/index.js';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import type { CronJob } from '../runner.js';
import { parseSchedule } from '../runner.js';
import type { ClawGlobalConfig } from '../../../foundation/config/index.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const GIT_GC_WEEKLY_CRON_TIMEOUT_MS = 120_000;

export interface GitGcWeeklyOptions {
  clawsDir: string;
  fs: FileSystem;
  audit: AuditLog;
  signal?: AbortSignal;
}

export interface GitGcWeeklyJobDeps {
  clawsDir: string;
  fs: FileSystem;
  audit: AuditLog;
}

export async function runGitGcWeekly(opts: GitGcWeeklyOptions): Promise<void> {
  const { clawsDir, fs, audit } = opts;

  if (!fs.existsSync(clawsDir)) return;

  const clawIds = fs.listSync(clawsDir, { includeDirs: true }).map(e => e.name);
  for (const clawId of clawIds) {
    if (opts.signal?.aborted) return;
    const gitDir = path.join(clawsDir, clawId, '.git');
    if (!fs.existsSync(gitDir)) continue;
    try {
      await exec('git', ['gc', '--auto'], { cwd: path.join(clawsDir, clawId) });
    } catch (err) {
      audit.write(
        CRON_AUDIT_EVENTS.GIT_GC_WEEKLY,
        `claw=${clawId}`,
        `step=gc_failed`,
        `error=${formatErr(err)}`,
      );
    }
  }

  audit.write(CRON_AUDIT_EVENTS.GIT_GC_WEEKLY, `step=complete`, `claws=${clawIds.length}`);
}

export function createGitGcWeeklyJob(
  deps: GitGcWeeklyJobDeps,
  globalConfig: ClawGlobalConfig,
): CronJob {
  return {
    name: 'git-gc-weekly',
    enabled: globalConfig.cron.jobs.git_gc_weekly.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.git_gc_weekly.schedule, deps.audit),
    handler: (signal) => runGitGcWeekly({ ...deps, signal }),
    timeoutMs: GIT_GC_WEEKLY_CRON_TIMEOUT_MS,
  };
}
