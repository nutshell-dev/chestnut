/**
 * @module L4.ContractSystem.Jobs.ArchiveLegacyMigrator
 * Phase 1127 Step E: idempotent migration of classified legacy flat archive entries
 * to typed state subdirectories (completed / cancelled / corrupted).
 */

import * as path from 'path';
import { formatErr } from '../../../foundation/node-utils/index.js';
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { PROGRESS_FILE } from '../dirs.js';
import {
  listArchiveContractLocationsAsync,
  archiveContainerDir,
  archiveStateContainerDir,
} from '../locations.js';
import type { ClawId } from '../../../foundation/claw-identity/index.js';
import { ContractProgressArchiveLooseSchema } from '../schemas.js';
import type { ArchiveState } from '../types.js';
import {
  emitContractArchiveLegacyMigrated,
  emitContractArchiveLegacyMigrationConflict,
  emitContractArchiveLegacyMigrationSkipped,
  emitContractArchiveLegacyMigrationFailed,
  emitContractArchiveLegacyMigrationSummary,
} from '../audit-emit.js';

const MIGRABLE_STATUSES: Readonly<Record<string, ArchiveState>> = {
  completed: 'completed',
  cancelled: 'cancelled',
  archive_corrupted: 'corrupted',
} as const;

export interface ArchiveLegacyMigratorContext {
  fs: FileSystem;
  audit: AuditLog;
}

export async function migrateLegacyArchiveEntries(
  ctx: ArchiveLegacyMigratorContext,
  clawId: ClawId,
  clawDir: string,
): Promise<{
  scanned: number;
  migrated: number;
  conflicts: number;
  skipped: number;
  failed: number;
}> {
  const archiveDir = path.join(clawDir, archiveContainerDir());
  let scanned = 0;
  let migrated = 0;
  let conflicts = 0;
  let skipped = 0;
  let failed = 0;

  let entries;
  try {
    entries = (await listArchiveContractLocationsAsync({ fs: ctx.fs, archiveDir }))
      .filter(e => e.kind === 'legacy');
  } catch (err) {
    if (isFileNotFound(err)) {
      return { scanned: 0, migrated: 0, conflicts: 0, skipped: 0, failed: 0 };
    }
    emitContractArchiveLegacyMigrationFailed(ctx.audit, {
      clawId,
      contractId: '<archive_dir>',
      context: 'list_archive_dir',
      error: String(err),
    });
    return { scanned: 0, migrated: 0, conflicts: 0, skipped: 0, failed: 1 };
  }

  for (const e of entries) {
    scanned++;
    const progressPath = path.join(e.contractRoot, PROGRESS_FILE);
    try {
      // phase 1127 Step E: source disappeared between enumeration and move →
      // concurrent migration already won; treat as observed, no false success.
      if (!(await ctx.fs.exists(e.contractRoot))) {
        continue;
      }

      let status: string | undefined;
      try {
        const raw = await ctx.fs.read(progressPath);
        let rawParsed: unknown;
        try {
          rawParsed = JSON.parse(raw);
        } catch (parseErr) {
          skipped++;
          emitContractArchiveLegacyMigrationSkipped(ctx.audit, {
            clawId,
            contractId: e.contractId,
            reason: `schema_invalid:${formatErr(parseErr)}`,
          });
          continue;
        }
        const validation = ContractProgressArchiveLooseSchema.safeParse(rawParsed);
        if (!validation.success) {
          skipped++;
          emitContractArchiveLegacyMigrationSkipped(ctx.audit, {
            clawId,
            contractId: e.contractId,
            reason: `schema_invalid:${validation.error.message}`,
          });
          continue;
        }
        status = validation.data.status ?? '';
      } catch (readErr) {
        if (isFileNotFound(readErr)) {
          skipped++;
          emitContractArchiveLegacyMigrationSkipped(ctx.audit, {
            clawId,
            contractId: e.contractId,
            reason: 'progress_missing',
          });
          continue;
        }
        throw readErr;
      }

      const targetState = MIGRABLE_STATUSES[status];
      if (!targetState) {
        skipped++;
        emitContractArchiveLegacyMigrationSkipped(ctx.audit, {
          clawId,
          contractId: e.contractId,
          reason: `unmigrable_status=${status || 'undefined'}`,
        });
        continue;
      }

      const stateContainer = archiveStateContainerDir(archiveDir, targetState);
      const targetDir = path.join(stateContainer, e.contractId);

      if (await ctx.fs.exists(targetDir)) {
        conflicts++;
        emitContractArchiveLegacyMigrationConflict(ctx.audit, {
          clawId,
          contractId: e.contractId,
          targetPath: path.relative(clawDir, targetDir),
          evidence: status,
        });
        continue;
      }

      await ctx.fs.ensureDir(stateContainer);
      await ctx.fs.move(e.contractRoot, targetDir);
      migrated++;
      emitContractArchiveLegacyMigrated(ctx.audit, {
        clawId,
        contractId: e.contractId,
        fromPath: path.relative(clawDir, e.contractRoot),
        toPath: path.relative(clawDir, targetDir),
        evidence: status,
      });
    } catch (err) {
      failed++;
      emitContractArchiveLegacyMigrationFailed(ctx.audit, {
        clawId,
        contractId: e.contractId,
        context: 'migrate_entry',
        error: String(err),
      });
    }
  }

  emitContractArchiveLegacyMigrationSummary(ctx.audit, {
    clawId,
    scanned,
    migrated,
    conflicts,
    skipped,
    failed,
  });
  return { scanned, migrated, conflicts, skipped, failed };
}
