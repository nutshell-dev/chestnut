import * as path from 'path';
import { formatErr } from "../../../foundation/utils/index.js";
import { type ChestnutRoot } from '../../../foundation/identity/index.js';
import { exec } from '../../../foundation/process-exec/index.js';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import { CLAWS_DIR } from '../../../foundation/paths.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const GIT_GC_WEEKLY_CRON_TIMEOUT_MS = 120_000;

export interface GitGcWeeklyOptions {
  chestnutRoot: ChestnutRoot;
  fs: FileSystem;
  audit: AuditLog;
  signal?: AbortSignal;
}

export async function runGitGcWeekly(opts: GitGcWeeklyOptions): Promise<void> {
  const { chestnutRoot, fs, audit } = opts;
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);

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
