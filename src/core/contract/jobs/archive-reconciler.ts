/**
 * @module L4.ContractSystem.Jobs.ArchiveReconciler
 * Phase 188 Step C: boot reconcile sweep for stale active-status entries in archive
 */

import * as path from 'path';
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { ACTIVE_STATUSES } from '../types.js';
import { CONTRACT_ARCHIVE_DIR, PROGRESS_FILE } from '../dirs.js';
import type { ClawId } from '../../../foundation/claw-identity/index.js';
import {
  emitContractArchiveReconcileStale,
  emitContractArchiveReconcileFailed,
  emitContractArchiveReconcileSummary,
} from '../audit-emit.js';
import { ContractProgressArchiveLooseSchema } from '../schemas.js';

// phase 351: ACTIVE_STATUSES 复用 types.ts (ML#1 共用基础设施单源、mirror phase 347/348 pattern)

export interface ArchiveReconcilerContext {
  fs: FileSystem;
  audit: AuditLog;
}

export async function reconcileArchiveStaleEntries(
  ctx: ArchiveReconcilerContext,
  clawId: ClawId,
  clawDir: string,
): Promise<{ swept: number; failed: number; scanned: number }> {
  const archiveDir = path.join(clawDir, CONTRACT_ARCHIVE_DIR);
  let swept = 0;
  let failed = 0;
  let scanned = 0;

  let dirs;
  try {
    dirs = await ctx.fs.list(archiveDir, { includeDirs: true });
  } catch (err) {
    if (isFileNotFound(err)) return { swept: 0, failed: 0, scanned: 0 };
    emitContractArchiveReconcileFailed(ctx.audit, {
      clawId, contractId: '<archive_dir>', context: 'list_archive_dir',
      error: String(err),
    });
    return { swept: 0, failed: 1, scanned: 0 };
  }

  for (const d of dirs.filter(e => e.isDirectory)) {
    scanned++;
    const progressPath = path.join(archiveDir, d.name, PROGRESS_FILE);
    try {
      const raw = await ctx.fs.read(progressPath);
      // phase 341 Zod SoT broaden (ML#9 优先编译器检查、复用 phase 332 loose schema、cluster N=10)
      const rawParsed: unknown = JSON.parse(raw);
      const validation = ContractProgressArchiveLooseSchema.safeParse(rawParsed);
      if (!validation.success) continue; // 解析失败、跳过 (archive use case loose、skip silent)
      const persisted = validation.data;
      // phase 365: phase 358 ContractProgressArchiveLooseSchema status field z.enum(ALL_CONTRACT_STATUSES_TUPLE) 后已 typed、cast 删除
      const currentStatus = persisted.status;
      // phase 351: cast string for typed Set runtime check (mirror phase 344 pattern)
      if (!currentStatus || !(ACTIVE_STATUSES as ReadonlySet<string>).has(currentStatus)) continue; // 终态跳过

      // 翻 archive_pending_recovery (non-derivable status、phase 330 strict schema align、无需 strip pattern)
      const oldStatus = currentStatus;
      const newPayload = { ...persisted, status: 'archive_pending_recovery' as const };
      await ctx.fs.writeAtomic(progressPath, JSON.stringify(newPayload, null, 2));

      emitContractArchiveReconcileStale(ctx.audit, {
        clawId, contractId: d.name, oldStatus, newStatus: 'archive_pending_recovery',
      });
      swept++;
    } catch (err) {
      if (isFileNotFound(err)) continue; // progress.json 缺失、archive partial state、跳过
      failed++;
      emitContractArchiveReconcileFailed(ctx.audit, {
        clawId, contractId: d.name, context: 'read_or_flip',
        error: String(err),
      });
    }
  }

  emitContractArchiveReconcileSummary(ctx.audit, { clawId, scanned, swept, failed });
  return { swept, failed, scanned };
}
