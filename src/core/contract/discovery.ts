/**
 * @module L4.ContractSystem.Discovery
 * Contract loading from active / paused dir
 */

import { isFileNotFound, type FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Contract } from '../contract/types.js';
import type { ProgressData } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import {
  emitContractProgressSchemaInvalid,
  emitContractProgressCorrupted,
} from './audit-emit.js';

export interface DiscoveryContext {
  fs: FileSystem;
  audit: AuditLog;
  loadContract: (contractId: string) => Promise<Contract>;
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
      const parsed = JSON.parse(raw) as { contract_id?: unknown; status?: unknown; subtasks?: unknown; started_at?: unknown };
      if (
        typeof parsed.contract_id !== 'string' ||
        typeof parsed.status !== 'string' ||
        typeof parsed.subtasks !== 'object' || parsed.subtasks === null
      ) {
        emitContractProgressSchemaInvalid(
          ctx.audit,
          { context: auditContext, contractId: entry.name, path: progressPath },
        );
        continue;
      }
      const data = parsed as ProgressData;
      const startedAt = data.started_at ?? '';
      if (!latest || startedAt > latest.startedAt) {
        latest = { name: entry.name, startedAt };
      }
    } catch (error) {
      // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
      if (!isFileNotFound(error)) {
        emitContractProgressCorrupted(
          ctx.audit,
          { file: entry.name, error: error instanceof Error ? error.message : String(error) },
        );
        emitContractProgressCorrupted(
          ctx.audit,
          { context: auditContext, contractId: entry.name, error: error instanceof Error ? error.message : String(error) },
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
  const contract = await ctx.loadContract(latest.name);
  contract.status = 'running';
  return contract;
}

export async function loadPausedContract(
  ctx: DiscoveryContext,
  pausedDir: string,
): Promise<Contract | null> {
  const latest = await findLatestContract(ctx, pausedDir, 'ContractSystem.loadPaused');
  if (!latest) return null;
  const contract = await ctx.loadContract(latest.name);
  contract.status = 'paused';
  return contract;
}
