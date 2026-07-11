import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { AuditLog } from '../../foundation/audit/index.js';
import { emitTaskCorrupt } from './audit-emit.js';

import type { SubAgentTask, ToolTask } from './types.js';
import { TaskSchema } from './task-schemas.js';

export function validateTaskShape(parsed: unknown): parsed is SubAgentTask | ToolTask {
  return TaskSchema.safeParse(parsed).success;
}

export async function backupCorruptTask(
  fs: FileSystem,
  auditWriter: AuditLog,
  filePath: string,
  _content: string,
  err: unknown,
): Promise<boolean> {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  let moveOk = true;
  let moveErr: unknown = undefined;
  try {
    // Phase 886: atomic move to backup path. This leaves the original file gone,
    // so downstream cancel/recovery can detect the corrupt backup and avoid
    // misreporting an ENOENT move as a dispatch race.
    await fs.move(filePath, backupPath);
  } catch (mErr) {
    moveOk = false;
    moveErr = mErr;
  }
  emitTaskCorrupt(auditWriter, {
    backup: backupPath,
    moveOk,
    moveError: moveOk ? undefined : auditWriter.message(formatErr(moveErr)),
    error: auditWriter.message(formatErr(err)),
  });
  return moveOk;
}
