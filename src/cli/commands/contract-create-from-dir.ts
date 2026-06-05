/**
 * Create a contract from a directory containing contract.yaml + verification/
 */

import * as path from 'path';
import { ContractSystem, CONTRACT_DIR } from '../../core/contract/index.js';
import { getClawDir } from '../../foundation/config/index.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ClawId } from '../../foundation/paths.js';
import { makeContractId } from '../../core/contract/types.js';
import { resolveChestnutRoot } from '../../foundation/paths.js';
import { parseAndValidateContractYaml, notifyContractCreated } from './contract-helpers.js';

export async function contractCreateFromDirCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: ClawId, dirPath: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const absDir = path.resolve(dirPath);
  const srcFs = deps.fsFactory(absDir);

  const yamlContent = srcFs.readSync('contract.yaml');
  const contract = parseAndValidateContractYaml(yamlContent);

  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);  // phase 1406: 单一 truth source
  const manager = new ContractSystem({ clawDir, clawId, fs: clawFs, audit: createSystemAudit(clawFs, clawDir), toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, chestnutRoot });

  const contractId = await manager.create(contract);
  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=dir`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  // Copy verification/ 目录（若存在；回退读取旧版 acceptance/）
  const srcDir = srcFs.existsSync('verification') ? 'verification' : srcFs.existsSync('acceptance') ? 'acceptance' : undefined;
  if (srcDir) {
    const destRel = path.join(CONTRACT_DIR, 'active', contractId, 'verification');
    await clawFs.ensureDir(destRel);
    const entries = await srcFs.list(srcDir);
    for (const entry of entries) {
      const srcRel = path.join(srcDir, entry.name);
      const srcStat = await srcFs.stat(srcRel);
      if (!srcStat.isFile) continue;   // 跳过子目录和符号链接
      const destFileRel = path.join(destRel, entry.name);
      const content = await srcFs.read(srcRel);
      await clawFs.writeAtomic(destFileRel, content);
      // .sh files get 0o755 via writeAtomic default 0o644; skipping chmod as per plan
    }
  }

  notifyContractCreated(deps, clawDir, clawId, makeContractId(contractId), contract);
}
