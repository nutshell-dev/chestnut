
/**
 * @module L4.SummonSystem
 * Summon system exports
 */

export { SummonTool } from './tools/summon.js';
export { createSummonVerifyPolicy } from './summon-verify-policy.js';
export { SUMMON_CALLER_TYPES } from './caller-types.js';
export { AskMotionTool } from './tools/ask-motion.js';
export { checkLegacySummonStateFiles } from './legacy-state-detection.js';

export {
  createSummonContractExtractPostProcessor,
  SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
} from './post-processors/contract-extract.js';

import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { SUMMON_AUDIT_EVENTS } from './audit-events.js';
import { type ContractId, makeContractId } from '../contract/index.js';
import { readPendingRetrospective, type PendingRetroRef } from './pending-retrospective.js';

// bulk API: per-file silent skip + audit emit (DP「不丢弃静默」修复)
export async function listPendingRetrospectives(opts: {
  fs: FileSystem;
  audit?: AuditLog;
  filter?: { contractId?: string };
}): Promise<PendingRetroRef[]> {
  const results: PendingRetroRef[] = [];
  const dir = `${CLAWSPACE_DIR}/pending-retrospective/by-contract`;
  if (!opts.fs.existsSync(dir)) return results;

  for (const e of opts.fs.listSync(dir, { includeDirs: false })) {
    if (!e.name.endsWith('.json')) continue;
    const contractId = makeContractId(e.name.replace(/\.json$/, ''));
    if (opts.filter?.contractId !== undefined && contractId !== opts.filter.contractId) continue;
    try {
      const ref = await readPendingRetrospective({ fs: opts.fs, contractId });
      results.push(ref);
    } catch (e) {
      // silent: bulk listing per-file parse-fail audit-emitted + skip
      opts.audit?.write(SUMMON_AUDIT_EVENTS.RETRO_INDEX_PARSE_FAILED, `contractId=${contractId}`, `reason=${formatErr(e)}`);
    }
  }

  return results;
}

/**
 * Phase 1206 Step B: legacy retrospective migration ack.
 * EvolutionSystem calls this only after the new ready row has been published
 * and re-read successfully. Non-FNF errors are propagated so migration can
 * preserve the original legacy row.
 */
export async function ackPendingRetrospective(opts: {
  fs: FileSystem;
  contractId: ContractId;
  audit?: AuditLog;
}): Promise<void> {
  const filePath = `${CLAWSPACE_DIR}/pending-retrospective/by-contract/${opts.contractId}.json`;
  try {
    await opts.fs.delete(filePath);
  } catch (e) {
    if (isFileNotFound(e)) return;
    opts.audit?.write(
      SUMMON_AUDIT_EVENTS.LEGACY_RETRO_ACK_FAILED,
      `contractId=${opts.contractId}`,
      `reason=${formatErr(e)}`,
    );
    throw e;
  }
}
