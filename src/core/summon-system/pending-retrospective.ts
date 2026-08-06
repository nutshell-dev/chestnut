import type { FileSystem } from '../../foundation/fs/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { type ContractId } from '../contract/index.js';

/** kebab-case claw id 模式 — 与 schema 内 targetClaw description 字面一致 */
const TARGET_CLAW_PATTERN = /^[a-z0-9-]+$/;

class InvalidTargetClawError extends Error {
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
