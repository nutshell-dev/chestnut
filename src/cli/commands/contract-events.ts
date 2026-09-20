/**
 * Show contract execution log for a claw
 */

import { collectContractEvents } from '../../core/contract/index.js';
import { getClawDir, makeClawId } from '../../foundation/claw-identity/index.js';
import { createClawContractAudit } from '../../assembly/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

export async function contractEventsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: string, sinceTs: number): Promise<void> {
  const clawDir = getClawDir(clawId);
  const fs = deps.fsFactory(clawDir);
  // phase 1874 Step F: audit 创建归 Assembly 轻量入口（按 action 最小依赖面；不用全栈）
  const { audit, dispose } = createClawContractAudit(deps, clawId);
  try {
    const result = await collectContractEvents(fs, clawDir, makeClawId(clawId), sinceTs, audit);
    if (result.events.length > 0) {
      console.log(result.events.join('\n'));
    }
  } finally {
    dispose();
  }
}
