/**
 * @module L4.ContractSystem.Discovery
 * Contract loading from active dir
 */

import { type ContractId, makeContractId } from './types.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Contract } from '../contract/types.js';

import {
  emitContractProgressSchemaInvalid,
  emitContractProgressCorrupted,
  emitContractMissingStartedAt,
} from './audit-emit.js';
import { ContractProgressPersistedSchema } from './schemas.js';
import { classifyActivePublication, isActivePublished } from './creation.js';

export interface DiscoveryContext {
  fs: FileSystem;
  audit: AuditLog;
  loadContract: (contractId: ContractId) => Promise<Contract>;
}

interface ActiveEntry {
  name: string;
  startedAt?: string;
}

function compareActiveEntries(a: ActiveEntry, b: ActiveEntry): number {
  const aMissing = a.startedAt === undefined;
  const bMissing = b.startedAt === undefined;
  // Missing started_at sorts first (priority over known times).
  if (aMissing && !bMissing) return -1;
  if (!aMissing && bMissing) return 1;
  // Both missing: tie-break by contract id ascending.
  if (aMissing && bMissing) return a.name.localeCompare(b.name);
  // Both known: sort by started_at ascending, then contract id ascending.
  const timeCompare = (a.startedAt as string).localeCompare(b.startedAt as string);
  if (timeCompare !== 0) return timeCompare;
  return a.name.localeCompare(b.name);
}

async function findContractsInDir(
  ctx: DiscoveryContext,
  dir: string,
  auditContext: string,
): Promise<ActiveEntry[]> {
  const exists = await ctx.fs.exists(dir);
  if (!exists) return [];

  const entries = await ctx.fs.list(dir, { includeDirs: true });
  const valid: ActiveEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const contractRoot = `${dir}/${entry.name}`;
    const publication = await classifyActivePublication({ fs: ctx.fs, contractRoot });
    if (!isActivePublished(publication)) continue;

    const progressPath = `${contractRoot}/progress.json`;
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
      const startedAt = result.data.started_at;
      const entryRecord: ActiveEntry = { name: entry.name };
      if (startedAt !== undefined && startedAt !== '') {
        entryRecord.startedAt = startedAt;
      }
      valid.push(entryRecord);
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

function sortActiveEntries(entries: ActiveEntry[]): ActiveEntry[] {
  return [...entries].sort(compareActiveEntries);
}

function emitMissingStartedAudits(
  audit: AuditLog,
  entries: ActiveEntry[],
  context: string,
): void {
  for (const entry of entries) {
    if (entry.startedAt === undefined) {
      emitContractMissingStartedAt(audit, {
        context,
        contractId: makeContractId(entry.name),
        reason: 'missing_started_at',
      });
    }
  }
}

export async function loadActiveContract(
  ctx: DiscoveryContext,
  activeDir: string,
): Promise<Contract | null> {
  const valid = await findContractsInDir(ctx, activeDir, 'ContractSystem.loadActive');
  const sorted = sortActiveEntries(valid);
  emitMissingStartedAudits(ctx.audit, sorted, 'ContractSystem.loadActive');
  if (sorted.length === 0) return null;
  // Step F: status is strictly derived from subtasks (DerivableStatus). Terminal
  // lifecycle states are committed by the directory path, not progress.status.
  return ctx.loadContract(makeContractId(sorted[0].name));
}

export async function loadAllActiveContracts(
  ctx: DiscoveryContext,
  activeDir: string,
): Promise<Array<{ name: string; startedAt: string }>> {
  const valid = await findContractsInDir(ctx, activeDir, 'ContractSystem.loadAllActiveContracts');
  const sorted = sortActiveEntries(valid);
  emitMissingStartedAudits(ctx.audit, sorted, 'ContractSystem.loadAllActiveContracts');
  return sorted.map(e => ({ name: e.name, startedAt: e.startedAt ?? '' }));
}
