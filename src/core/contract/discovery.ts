/**
 * @module L4.ContractSystem.Discovery
 * Contract loading from active / paused dir
 */

import { type ContractId, makeContractId } from './types.js';
import { formatErr } from "../../foundation/utils/index.js";
import { isFileNotFound, type FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Contract } from '../contract/types.js';

import {
  emitContractProgressSchemaInvalid,
  emitContractProgressCorrupted,
} from './audit-emit.js';
import { ContractProgressPersistedSchema } from './schemas.js';

export interface DiscoveryContext {
  fs: FileSystem;
  audit: AuditLog;
  loadContract: (contractId: ContractId) => Promise<Contract>;
}

interface LatestEntry { name: string; startedAt: string; }

async function findLatestContract(
  ctx: DiscoveryContext,
  dir: string,
  auditContext: string,
): Promise<LatestEntry | null> {
  const exists = await ctx.fs.exists(dir);
  if (!exists) return null;

  const entries = await ctx.fs.list(dir, { includeDirs: true });
  let latest: LatestEntry | null = null;

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
      if (!latest || startedAt > latest.startedAt) {
        latest = { name: entry.name, startedAt };
      }
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

  return latest;
}

export async function loadActiveContract(
  ctx: DiscoveryContext,
  activeDir: string,
): Promise<Contract | null> {
  const latest = await findLatestContract(ctx, activeDir, 'ContractSystem.loadActive');
  if (!latest) return null;
  const contract = await ctx.loadContract(makeContractId(latest.name));
  contract.status = 'running';
  return contract;
}

export async function loadPausedContract(
  ctx: DiscoveryContext,
  pausedDir: string,
): Promise<Contract | null> {
  const latest = await findLatestContract(ctx, pausedDir, 'ContractSystem.loadPaused');
  if (!latest) return null;
  const contract = await ctx.loadContract(makeContractId(latest.name));
  contract.status = 'paused';
  return contract;
}
