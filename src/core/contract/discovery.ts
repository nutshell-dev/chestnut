/**
 * @module L4.ContractSystem.Discovery
 * Contract loading from active / paused dir
 */

import { type ContractId, makeContractId } from './types.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Contract } from '../contract/types.js';

import {
  emitContractProgressSchemaInvalid,
  emitContractProgressCorrupted,
  emitMultiActiveContracts,
} from './audit-emit.js';
import { ContractProgressPersistedSchema } from './schemas.js';
import { MultipleActiveContractsError } from './errors.js';

export interface DiscoveryContext {
  fs: FileSystem;
  audit: AuditLog;
  loadContract: (contractId: ContractId) => Promise<Contract>;
}

interface LatestEntry { name: string; startedAt: string; }

async function findContractsInDir(
  ctx: DiscoveryContext,
  dir: string,
  auditContext: string,
): Promise<LatestEntry[]> {
  const exists = await ctx.fs.exists(dir);
  if (!exists) return [];

  const entries = await ctx.fs.list(dir, { includeDirs: true });
  const valid: LatestEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const progressPath = `${dir}/${entry.name}/progress.json`;
    const hasProgress = await ctx.fs.exists(progressPath);
    if (!hasProgress) continue;

    try {
      const raw = await ctx.fs.read(progressPath);
      const rawParsed: unknown = JSON.parse(raw);
      // phase 325 Zod SoT broaden (mirror phase 319 ContractProgressPersistedSchema strict)
      // strip legacy derive fields (contract_id + status) before strict safeParse
      const obj = rawParsed as Record<string, unknown>;
      delete obj.contract_id;
      delete obj.status;
      const result = ContractProgressPersistedSchema.safeParse(obj);
      if (!result.success) {
        emitContractProgressSchemaInvalid(
          ctx.audit,
          { context: auditContext, contractId: entry.name, path: progressPath },
        );
        continue;
      }
      const startedAt = result.data.started_at ?? '';
      valid.push({ name: entry.name, startedAt });
    } catch (error) {
      // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
      if (!isFileNotFound(error)) {
        emitContractProgressCorrupted(
          ctx.audit,
          { file: entry.name, error: formatErr(error) },
        );
        emitContractProgressCorrupted(
          ctx.audit,
          { context: auditContext, contractId: entry.name, error: formatErr(error) },
        );
      }
      continue;
    }
  }

  return valid;
}

async function findLatestContract(
  ctx: DiscoveryContext,
  dir: string,
  auditContext: string,
): Promise<LatestEntry | null> {
  const valid = await findContractsInDir(ctx, dir, auditContext);
  if (valid.length === 0) return null;
  let latest = valid[0];
  for (const entry of valid) {
    if (entry.startedAt > latest.startedAt) {
      latest = entry;
    }
  }
  return latest;
}

export async function loadActiveContract(
  ctx: DiscoveryContext,
  activeDir: string,
): Promise<Contract | null> {
  const valid = await findContractsInDir(ctx, activeDir, 'ContractSystem.loadActive');
  if (valid.length === 0) return null;
  if (valid.length > 1) {
    const contractIds = valid.map(e => makeContractId(e.name));
    emitMultiActiveContracts(ctx.audit, {
      context: 'ContractSystem.loadActive',
      count: valid.length,
      contractIds,
    });
    // phase 957: fail-closed — 多 active 不再静默返回 latest，强制 reconciler 介入。
    throw new MultipleActiveContractsError(
      `Found ${valid.length} active contracts: ${contractIds.join(', ')}. Run contract reconciler.`,
      contractIds,
    );
  }
  // phase 324 C2: 不再覆盖 status——loadContract 已从 progress 派生（含 cancelled /
  // crashed / archive_pending_recovery 等终态、boot race / mid-archive 残留时不再
  // 谎报 running，下游 auditor / dialog injector / status service 不被毒化。
  return ctx.loadContract(makeContractId(valid[0].name));
}

export async function loadAllActiveContracts(
  ctx: DiscoveryContext,
  activeDir: string,
): Promise<Array<{ name: string; startedAt: string }>> {
  const valid = await findContractsInDir(ctx, activeDir, 'ContractSystem.loadAllActiveContracts');
  if (valid.length > 1) {
    emitMultiActiveContracts(ctx.audit, {
      context: 'ContractSystem.loadAllActiveContracts',
      count: valid.length,
      contractIds: valid.map(e => makeContractId(e.name)),
    });
  }
  return valid;
}

export async function loadPausedContract(
  ctx: DiscoveryContext,
  pausedDir: string,
): Promise<Contract | null> {
  const latest = await findLatestContract(ctx, pausedDir, 'ContractSystem.loadPaused');
  if (!latest) return null;
  // phase 324 C2: 同 loadActiveContract — 不覆盖 status，信任 progress 派生。
  return ctx.loadContract(makeContractId(latest.name));
}
