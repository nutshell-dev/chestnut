/**
 * @module L2c.FileTool
 * Shared version-checked commit coordinator for edit / multi_edit.
 *
 * phase 1109 Step C: unifies the commit pipeline so that edit/multi_edit only
 * compute the candidate; this module owns conflict detection, fail-closed backup,
 * atomic write, post-write verification and audit.
 *
 * phase 1227 Step A: removes the internal edit scheduling queue. Write tool
 * ordering within a single agent execution is owned by L3 StepExecutor; FileTool
 * only performs the version-checked commit and does not claim cross-context,
 * cross-process or IDE-level mutual exclusion.
 */

import type { ExecContext } from '../tools/index.js';
import { computeContentHash } from './file-hash.js';
import { backupToSync } from './sync-backup.js';
import { recordEditResult } from './file-state-manager.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';

type EditCommitTool = 'edit' | 'multi_edit';
type EditCommitBackupSource = 'edit_backup' | 'multi_edit_backup';

interface EditCommitInput {
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

/**
 * Commit a file edit through the shared FileTool pipeline.
 *
 * Pipeline:
 * 1. Compute beforeHash from the original content the tool read.
 * 2. Re-read current content; hash mismatch = conflict (0 writes).
 * 3. Backup original to syncDir; backup failure = fail closed (0 target writes).
 * 4. Atomic write candidate.
 * 5. Re-read committed content; hash mismatch = verification failure.
 * 6. Record readFileState + emit committed audit.
 *
 * The caller (L3 StepExecutor) is responsible for ordering write tool calls
 * within a single agent execution. FileTool does not serialize concurrent
 * commits and does not guarantee cross-context or cross-process lost-update
 * prevention.
 */
export async function editCommit(
  input: EditCommitInput,
): Promise<EditCommitResult> {
  const { ctx, tool, path, resolved, original, candidate, backupSource, replaced, editCount } = input;
  const beforeHash = computeContentHash(original);
  const candidateHash = computeContentHash(candidate);

  // 2. Pre-commit conflict detection by content hash.
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

  // 3. Fail-closed backup.
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

  // 4. Atomic write.
  await ctx.fs.writeAtomic(resolved, candidate);

  // 5. Post-write verification.
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

  // 6. Record state + audit.
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
}
