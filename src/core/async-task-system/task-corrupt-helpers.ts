import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { emitTaskCorrupt } from './audit-emit.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../../foundation/audit/index.js';
import type { SubAgentTask, ToolTask } from './types.js';
import { TaskSchema } from './task-schemas.js';

export function validateTaskShape(parsed: unknown): parsed is SubAgentTask | ToolTask {
  return TaskSchema.safeParse(parsed).success;
}

export async function backupCorruptTask(
  fs: FileSystem,
  auditWriter: AuditLog,
  filePath: string,
  content: string,
  err: unknown,
): Promise<void> {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  let moveOk = true;
  let moveErr: unknown = undefined;
  try {
    await fs.writeAtomic(backupPath, content);
    await fs.delete(filePath);
  } catch (mErr) {
    moveOk = false;
    moveErr = mErr;
  }
  emitTaskCorrupt(auditWriter, {
    backup: backupPath,
    moveOk,
    moveError: moveOk ? undefined : (moveErr instanceof Error ? moveErr.message : String(moveErr)).slice(0, AUDIT_MESSAGE_MAX_CHARS),
    error: (err instanceof Error ? err.message : String(err)).slice(0, AUDIT_MESSAGE_MAX_CHARS),
  });
}
