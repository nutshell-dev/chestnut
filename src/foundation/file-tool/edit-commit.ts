/**
 * @module L2c.FileTool
 * Shared version-checked commit coordinator for edit / multi_edit.
 *
 * phase 1109 Step C: unifies the commit pipeline so that edit/multi_edit only
 * compute the candidate; this module owns serialization, conflict detection,
 * fail-closed backup, atomic write, post-write verification and audit.
 */

import type { ExecContext } from '../tools/index.js';
import { computeContentHash } from './file-hash.js';
import { backupToSync } from './sync-backup.js';
import { recordEditResult } from './file-state-manager.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';

export type EditCommitTool = 'edit' | 'multi_edit';
export type EditCommitBackupSource = 'edit_backup' | 'multi_edit_backup';

export interface EditCommitInput {
  ctx: ExecContext;
  tool: EditCommitTool;
  path: string;
  resolved: string;
  original: string;
  candidate: string;
  backupSource: EditCommitBackupSource;
  replaced: number;
  editCount: number;
}

export type EditCommitResult =
  | {
      ok: true;
      beforeHash: string;
      afterHash: string;
      backupPath: string;
      mtime: number;
    }
  | {
      ok: false;
      reason: 'conflict' | 'backup-failed' | 'verification-failed';
      content: string;
    };

// Per-runtime (ExecContext-bound) per-resolved-path serialization queues.
// WeakMap keeps the queue lifecycle tied to the context instead of a global Map.
const contextQueues = new WeakMap<ExecContext, Map<string, Promise<unknown>>>();

/**
 * Enqueue `task` so that for a given `(ctx, resolvedPath)` at most one task
 * runs at a time. Previous task failures do not block subsequent tasks.
 * Idle queue keys are cleaned up automatically.
 */
function enqueue<T>(ctx: ExecContext, resolvedPath: string, task: () => Promise<T>): Promise<T> {
  let map = contextQueues.get(ctx);
  if (!map) {
    map = new Map<string, Promise<unknown>>();
    contextQueues.set(ctx, map);
  }

  const chain = map.get(resolvedPath);
  const next = (chain ?? Promise.resolve())
    .catch(() => {
      // silent: previous task failure must not block subsequent queued tasks;
      // the mutex only serializes, it does not propagate rejections.
    })
    .then(task)
    .finally(() => {
      if (map!.get(resolvedPath) === next) {
        map!.delete(resolvedPath);
      }
    });

  map.set(resolvedPath, next);
  return next;
}

/**
 * Commit a file edit through the shared FileTool pipeline.
 *
 * Pipeline:
 * 1. Compute beforeHash from the original content the tool read.
 * 2. Enter a per-(ctx, resolvedPath) serial queue.
 * 3. Re-read current content; hash mismatch = conflict (0 writes).
 * 4. Backup original to syncDir; backup failure = fail closed (0 target writes).
 * 5. Atomic write candidate.
 * 6. Re-read committed content; hash mismatch = verification failure.
 * 7. Record readFileState + emit committed audit.
 */
export async function editCommit(
  input: EditCommitInput,
): Promise<EditCommitResult> {
  const { ctx, tool, path, resolved, original, candidate, backupSource, replaced, editCount } = input;
  const beforeHash = computeContentHash(original);
  const candidateHash = computeContentHash(candidate);

  return enqueue(ctx, resolved, async () => {
    // 3. Pre-commit conflict detection by content hash.
    const current = await ctx.fs.read(resolved);
    const currentHash = computeContentHash(current);
    if (currentHash !== beforeHash) {
      ctx.auditWriter?.write(
        FILE_TOOL_AUDIT_EVENTS.FILE_EDIT_CONFLICT,
        `tool=${tool}`,
        `path=${path}`,
        `before_hash=${beforeHash}`,
        `current_hash=${currentHash}`,
        `stage=precommit`,
      );
      return {
        ok: false,
        reason: 'conflict',
        content: `Error: File '${path}' was modified externally between read and write (content changed). Re-read the file with \`read\` and retry the edit with current content.`,
      } as EditCommitResult;
    }

    // 4. Fail-closed backup.
    const backupPath = await backupToSync(ctx, resolved, backupSource);
    if (!backupPath) {
      const reason = `backup failed for ${tool} on ${resolved}`;
      ctx.auditWriter?.write(
        FILE_TOOL_AUDIT_EVENTS.FILE_EDIT_BACKUP_FAILED,
        `tool=${tool}`,
        `path=${path}`,
        `before_hash=${beforeHash}`,
        `reason=${reason}`,
      );
      return {
        ok: false,
        reason: 'backup-failed',
        content: `Error: Edit failed because the backup could not be created for '${path}'. The original file was not modified.`,
      } as EditCommitResult;
    }

    // 5. Atomic write.
    await ctx.fs.writeAtomic(resolved, candidate);

    // 6. Post-write verification.
    const committed = await ctx.fs.read(resolved);
    const committedHash = computeContentHash(committed);
    if (committedHash !== candidateHash) {
      ctx.auditWriter?.write(
        FILE_TOOL_AUDIT_EVENTS.FILE_EDIT_VERIFICATION_FAILED,
        `tool=${tool}`,
        `path=${path}`,
        `expected_hash=${candidateHash}`,
        `actual_hash=${committedHash}`,
        `backup_path=${backupPath}`,
      );
      return {
        ok: false,
        reason: 'verification-failed',
        content: `Error: Edit verification failed for '${path}' (committed content does not match candidate). Backup available at ${backupPath}. Re-read the file and decide whether to restore or retry.`,
      } as EditCommitResult;
    }

    // 7. Record state + audit.
    const newStat = await ctx.fs.stat(resolved);
    const mtime = newStat.mtime.getTime();
    // phase 1437: recordEditResult preserves inherited isFullRead.
    recordEditResult(ctx, resolved, committed, mtime);

    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.FILE_EDIT_COMMITTED,
      `tool=${tool}`,
      `path=${path}`,
      `before_hash=${beforeHash}`,
      `after_hash=${committedHash}`,
      `backup_path=${backupPath}`,
      `replaced=${replaced}`,
      `edit_count=${editCount}`,
    );

    return {
      ok: true,
      beforeHash,
      afterHash: committedHash,
      backupPath,
      mtime,
    } as EditCommitResult;
  });
}
