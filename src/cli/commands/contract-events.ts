/**
 * Show contract execution log for a claw
 */

import { collectContractEvents } from '../../core/contract/index.js';
import { getClawDir } from '../../core/claw-topology/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';

export async function contractEventsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: string, sinceTs: number): Promise<void> {
  const clawDir = getClawDir(clawId);
  const fs = deps.fsFactory(clawDir);
  const audit = createSystemAudit(fs, clawDir);
  const result = await collectContractEvents(fs, clawDir, makeClawId(clawId), sinceTs, audit);
  if (result.events.length > 0) {
    console.log(result.events.join('\n'));
  }
}
