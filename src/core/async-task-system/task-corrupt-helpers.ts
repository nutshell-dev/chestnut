import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from "../../foundation/utils/index.js";
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
    moveError: moveOk ? undefined : auditWriter.message(formatErr(moveErr)),
    error: auditWriter.message(formatErr(err)),
  });
}
