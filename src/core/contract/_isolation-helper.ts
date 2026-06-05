/**
 * @module L4.ContractSystem.IsolationHelper
 * phase 66: schema corruption 隔离共用 helper
 *
 * 3 文件（lock.ts / manager.ts / persistence.ts）共用 — 共同流程：
 *   1. 计算 corruptedDir = <contract_dir>/corrupted/
 *   2. ensureDir corruptedDir
 *   3. backupPath = <corruptedDir>/<Date.now()>_<basename>
 *   4. fs.move 原文件 → backupPath
 *   5. emit CONTRACT_FILE_ISOLATED audit
 *
 * 失败时返 null（move 失败 = 文件可能已被消费者删 / perm denied、不阻塞主流程）。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ContractId } from './types.js';
import { formatErr } from '../../foundation/utils/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

export interface IsolationArgs {
  contractId: ContractId;
  contractDir: string;
  filename: string;        // e.g. 'contract.yaml' | 'progress.json' | 'progress.lock'
  reason: string;          // 'unknown_schema_version' | 'schema_invalid'
}

export async function isolateCorruptedFile(
  fs: FileSystem,
  audit: AuditLog,
  args: IsolationArgs,
): Promise<{ backupPath: string } | null> {
  const corruptedDir = path.join(args.contractDir, 'corrupted');
  try {
    await fs.ensureDir(corruptedDir);
    const ts = Date.now();
    const backupPath = path.join(corruptedDir, `${ts}_${args.filename}`);
    const srcPath = path.join(args.contractDir, args.filename);
    await fs.move(srcPath, backupPath);
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_FILE_ISOLATED,
      `contractId=${args.contractId}`,
      `filename=${args.filename}`,
      `reason=${args.reason}`,
      `backupPath=${backupPath}`,
    );
    return { backupPath };
  } catch (err) {
    // 隔离失败（race / perm denied）→ audit + return null、不阻塞 markCrashed
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_FILE_ISOLATION_FAILED,
      `contractId=${args.contractId}`,
      `filename=${args.filename}`,
      `reason=${formatErr(err)}`,
    );
    return null;
  }
}
