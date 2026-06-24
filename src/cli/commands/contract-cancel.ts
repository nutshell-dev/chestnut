/**
 * Cancel an active or paused contract (moves to archive with status=cancelled).
 *
 * Thin CLI wrapper around ContractSystem.cancel — business logic (lock /
 * saveProgress / abort verifier / fs.move) lives in core/contract/lifecycle.ts.
 */

import { resolveChestnutRoot } from '../../core/claw-topology/claw-instance-paths.js';
import { ContractSystem } from '../../core/contract/index.js';
import { getClawDir } from '../../foundation/config/index.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { CliError } from '../errors.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { makeContractId } from '../../core/contract/types.js';
// CLAWS_DIR and path removed: phase 263

export async function contractCancelCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawId: string,
  reason: string,
  contractIdInput: string | undefined,
  extraDeps?: { audit?: AuditLog },
): Promise<void> {
  const audit = extraDeps?.audit;
  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);
  const clawAudit = createSystemAudit(clawFs, clawDir);
  const manager = new ContractSystem({ clawDir, clawId: makeClawId(clawId), fs: clawFs, audit: clawAudit, toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, notifyClaw: (targetClawId, message) => notifyClaw(clawFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, message, clawAudit) });

  let resolvedId = contractIdInput;
  if (!resolvedId) {
    const active = await manager.loadActive();
    if (!active) {
      throw new CliError(`No active contract for claw ${clawId}`);
    }
    resolvedId = active.id;
  }

  try {
    await manager.cancel(makeContractId(resolvedId), reason);
  } catch (err) {
    throw new CliError(
      `Failed to cancel contract "${resolvedId}" for claw ${clawId}`,
      { cause: err },
    );
  }

  audit?.write(
    CLI_AUDIT_EVENTS.CONTRACT_CANCEL,
    `claw=${clawId}`,
    `contract=${resolvedId}`,
    `reason=${reason}`,
  );
  console.log(`Contract cancelled: ${resolvedId} (reason: ${reason})`);
}
