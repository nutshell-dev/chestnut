/**
 * Create a contract for a claw
 */

import * as path from 'path';
import { ContractSystem } from '../../core/contract/index.js';
import { getClawDir } from '../../foundation/config/index.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ClawId } from '../../foundation/paths.js';
import { makeContractId } from '../../core/contract/types.js';
import { resolveChestnutRoot } from '../../foundation/paths.js';
import { parseAndValidateContractYaml, notifyContractCreated } from './contract-helpers.js';

export async function contractCreateCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: ClawId, filePath: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const absFilePath = path.resolve(filePath);
  const fileSystem = deps.fsFactory(path.dirname(absFilePath));
  const yamlContent = fileSystem.readSync(path.basename(absFilePath));
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  // phase 1389: regular claw chestnutRoot 双层 up / mirror assemble.ts:279 模板 (phase 1387 Step B + bff2dcfc follow-up)
  const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);  // phase 1406: 单一 truth source
  const manager = new ContractSystem({ clawDir, clawId, fs: clawFs, audit: createSystemAudit(clawFs, clawDir), toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, chestnutRoot });

  const contractId = await manager.create(contract);
  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=file`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  notifyContractCreated(deps, clawDir, clawId, makeContractId(contractId), contract);
}
