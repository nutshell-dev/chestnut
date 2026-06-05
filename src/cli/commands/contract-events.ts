/**
 * Show contract execution log for a claw
 */

import { collectContractEvents } from '../../core/contract/index.js';
import { getClawDir } from '../../foundation/config/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ClawId } from '../../foundation/paths.js';

export async function contractEventsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: ClawId, sinceTs: number): Promise<void> {
  const clawDir = getClawDir(clawId);
  const fs = deps.fsFactory(clawDir);
  const audit = createSystemAudit(fs, clawDir);
  const result = collectContractEvents(fs, clawDir, clawId, sinceTs, audit);
  if (result.events.length > 0) {
    console.log(result.events.join('\n'));
  }
}
