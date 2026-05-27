/**
 * Pending tool task file writer.
 *
 * Direct file-based scheduling primitive for async tool tasks.
 * Watcher (AsyncTaskSystem._ingestPendingFile) consumes the file asynchronously.
 */
import { randomUUID } from 'crypto';
import { TASKS_QUEUES_PENDING_DIR } from '../dirs.js';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { AsyncToolTaskArgs } from '../../../foundation/tools/index.js';
import { emitTaskScheduled } from '../audit-emit.js';
import { makeTaskId } from '../types.js';


/**
 * Write a pending tool task file. Watcher will pick it up.
 * @returns The generated taskId.
 */
export async function writePendingToolTaskFile(
  fs: FileSystem,
  audit: AuditLog | undefined,
  args: AsyncToolTaskArgs,
): Promise<string> {
  const taskId = makeTaskId(randomUUID());
  const task = {
    id: taskId,
    createdAt: new Date().toISOString(),
    ...args,
    kind: 'tool' as const,  // placed last to prevent spread override
  };
  await fs.writeAtomic(
    `${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`,
    JSON.stringify(task, null, 2),
  );
  if (audit) {
    emitTaskScheduled(audit, {
      taskId,
      kind: 'tool',
      parent: args.parentClawId,
      tool: args.toolName,
      isShadow: args.isShadow,
    });
  }
  return taskId;
}
