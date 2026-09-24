/**
 * Create a contract for a claw
 */

import * as path from 'path';
import { getClawDir, resolveChestnutRoot } from '../../foundation/claw-identity/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { makeContractId } from '../../core/contract/index.js';
import { createContractActionContext } from '../../assembly/index.js';
import { parseAndValidateContractYaml, notifyContractCreated } from './contract-helpers.js';

export async function contractCreateCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: string, filePath: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const absFilePath = path.resolve(filePath);
  const fileSystem = deps.fsFactory(path.dirname(absFilePath));
  const yamlContent = fileSystem.readSync(path.basename(absFilePath));
  const contract = parseAndValidateContractYaml(yamlContent);

  // phase 1874 Step F: 装配归 Assembly 窄入口（CLI 不再构造 AuditLog/ToolRegistry/ContractSystem）
  // phase 1901 Step B: 注册 summon-verify policy（policy-only，不附带 --dir 的 support tools）；
  // task identity 经 create options 传入 policy loop（与 --dir 路径同一来源）。
  const action = await createContractActionContext(deps, clawId, {
    registerSummonVerifyPolicy: true,
  });
  let contractId: string;
  try {
    contractId = await action.system.create({
      contract,
      subagentTaskId: process.env.CHESTNUT_SUBAGENT_TASK_ID,
      clawDir: clawId,
    });
  } finally {
    action.dispose();
  }

  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=file`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  const clawDir = getClawDir(clawId);
  const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);
  notifyContractCreated(deps, clawDir, clawId, makeContractId(contractId), contract, chestnutRoot);
}
