/**
 * Cancel an active contract (moves to archive with status=cancelled).
 *
 * Thin CLI wrapper around ContractSystem.cancel — business logic lives in
 * core/contract/lifecycle.ts.
 */

import { resolveChestnutRoot } from '../../core/claw-topology/index.js';
import { ContractSystem } from '../../core/contract/index.js';
import { getClawDir } from '../../core/claw-topology/index.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { routeNotifyClaw } from '../../core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { CliError } from '../errors.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { makeContractId } from '../../core/contract/index.js';
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
  const manager = new ContractSystem({ clawDir, clawId: makeClawId(clawId), fs: clawFs, audit: clawAudit, toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, notifyClaw: (targetClawId, message) => routeNotifyClaw(clawFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, message, clawAudit) });

  let resolvedId = contractIdInput;
  if (!resolvedId) {
    const active = await manager.loadActive();
    if (!active) {
      throw new CliError(`No active contract for claw ${clawId}`);
    }
    resolvedId = active.id;
  }

  let outcome;
  try {
    outcome = await manager.cancel(makeContractId(resolvedId), reason);
  } catch (err) {
    throw new CliError(
      `Failed to cancel contract "${resolvedId}" for claw ${clawId}`,
      { cause: err },
    );
  }

  // phase 1862 Step C (CT-D2)：终态 transition 单一 typed outcome，commit 字段承载 winner 判定。
  const commit = outcome.commit;

  if (commit.kind === 'committed') {
    audit?.write(
      CLI_AUDIT_EVENTS.CONTRACT_CANCEL,
      `claw=${clawId}`,
      `contract=${resolvedId}`,
      `reason=${reason}`,
    );
    console.log(`Contract cancelled: ${resolvedId} (reason: ${reason})`);
    return;
  }

  if (commit.kind === 'already_committed') {
    audit?.write(
      CLI_AUDIT_EVENTS.CONTRACT_CANCEL,
      `claw=${clawId}`,
      `contract=${resolvedId}`,
      `reason=${reason}`,
    );
    console.log(`Contract already cancelled: ${resolvedId}`);
    return;
  }

  if (commit.kind === 'lost_to_state') {
    throw new CliError(
      `Contract "${resolvedId}" is already in terminal state: ${commit.committed}`,
      { cause: commit },
    );
  }

  // retryable_failure
  throw new CliError(
    `Failed to cancel contract "${resolvedId}": ${commit.cause ?? 'unknown'}`,
    { cause: commit.cause ?? 'unknown' },
  );
}
