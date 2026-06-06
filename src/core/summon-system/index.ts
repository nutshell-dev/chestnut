/**
 * @module L4.SummonSystem
 * Summon system exports
 */

export { SummonTool, SUMMON_TOOL_NAME } from './tools/summon.js';
export { createSummonStateStore, type SummonStateStore, type SummonDecision } from './summon-state-store.js';
export { createSummonContractCreateGate, type SummonContractCreateGate } from './contract-create-gate.js';
export { SUMMON_CALLER_TYPES, type SummonCallerType } from './caller-types.js';
export { AskMotionTool, ASK_MOTION_TOOL_NAME, ASK_MOTION_TOOL_DESCRIPTION, ASK_MOTION_TOOL_SCHEMA } from './tools/ask-motion.js';
export { SUMMON_AUDIT_EVENTS, emitSummonDispatched, emitSummonRejectedShadow } from './audit-events.js';
export {
  summonContractExtractPostProcessor,
  SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
} from './post-processors/contract-extract.js';

import type { FileSystem } from '../../foundation/fs/types.js';
import { formatErr } from "../../foundation/utils/index.js";
import { CLAWSPACE_DIR } from '../../assembly/claw-dirs.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { SUMMON_AUDIT_EVENTS } from './audit-events.js';
import { type ContractId, makeContractId } from '../contract/types.js';

/** kebab-case claw id 模式 — 与 schema 内 targetClaw description 字面一致 */
const TARGET_CLAW_PATTERN = /^[a-z0-9-]+$/;

export class InvalidTargetClawError extends Error {
  constructor(public readonly raw: string) {
    super(`targetClaw must match /^[a-z0-9-]+$/, got ${JSON.stringify(raw)}`);
    this.name = 'InvalidTargetClawError';
  }
}

/** Phase 1335 (r138 F fork): cross-module query API — pending retrospective reference */
export interface PendingRetroRef {
  contractId: ContractId;
  targetClaw: string;
  mode?: string;
  miningTaskId?: string;
  shadowTaskId?: string;
  createdAt?: string;
}

export class InvalidJSONError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'InvalidJSONError';
  }
}

export class UnexpectedFormatError extends Error {
  constructor(message: string, public readonly parsed: unknown) {
    super(message);
    this.name = 'UnexpectedFormatError';
  }
}

// NEW single-file precise API
export async function readPendingRetrospective(opts: {
  fs: FileSystem;
  contractId: ContractId;
}): Promise<PendingRetroRef> {
  const filePath = `${CLAWSPACE_DIR}/pending-retrospective/by-contract/${opts.contractId}.json`;
  const raw = await opts.fs.read(filePath); // FileNotFoundError / EISDIR / etc propagate
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new InvalidJSONError((e as Error).message, raw);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new UnexpectedFormatError(`expected object, got ${typeof parsed}`, parsed);
  }
  const p = parsed as Record<string, unknown>;
  const targetClawRaw = typeof p.targetClaw === 'string' ? p.targetClaw : '';
  if (!TARGET_CLAW_PATTERN.test(targetClawRaw)) {
    throw new InvalidTargetClawError(targetClawRaw);
  }
  return {
    contractId: opts.contractId,
    targetClaw: targetClawRaw,
    mode: typeof p.mode === 'string' ? p.mode : undefined,
    miningTaskId: typeof p.miningTaskId === 'string' ? p.miningTaskId : undefined,
    shadowTaskId: typeof p.shadowTaskId === 'string' ? p.shadowTaskId : undefined,
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : undefined,
  };
}

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
