/**
 * Create a contract for a claw
 */

import { resolveChestnutRoot } from '../../core/claw-topology/claw-instance-paths.js';
// CLAWS_DIR removed: phase 263
import * as path from 'path';
import { ContractSystem } from '../../core/contract/index.js';
import { getClawDir } from '../../core/claw-topology/claw-instance-paths.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { routeNotifyClaw } from '../../core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { makeContractId } from '../../core/contract/types.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { parseAndValidateContractYaml, notifyContractCreated } from './contract-helpers.js';

export async function contractCreateCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: string, filePath: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const absFilePath = path.resolve(filePath);
  const fileSystem = deps.fsFactory(path.dirname(absFilePath));
  const yamlContent = fileSystem.readSync(path.basename(absFilePath));
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  // phase 1389: regular claw chestnutRoot 双层 up / mirror assemble.ts:279 模板 (phase 1387 Step B + bff2dcfc follow-up)
  const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);  // phase 1406: 单一 truth source
  const clawAudit = createSystemAudit(clawFs, clawDir);
  const manager = new ContractSystem({ clawDir, clawId: makeClawId(clawId), fs: clawFs, audit: clawAudit, toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, notifyClaw: (targetClawId, message) => routeNotifyClaw(clawFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, message, clawAudit) });

  const contractId = await manager.create(contract);
  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=file`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  notifyContractCreated(deps, clawDir, clawId, makeContractId(contractId), contract, chestnutRoot);
}
