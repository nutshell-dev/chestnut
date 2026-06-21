/**
 * Pending tool task file writer.
 *
 * Direct file-based scheduling primitive for async tool tasks.
 * Watcher (AsyncTaskSystem._ingestPendingFile) consumes the file asynchronously.
 */
import { newUuid } from '../../../foundation/uuid.js';
import { TASKS_QUEUES_PENDING_DIR } from '../dirs.js';
import type { FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { AsyncToolTaskArgs } from '../../../foundation/tools/index.js';
import { emitTaskScheduled } from '../audit-emit.js';
import { assertTaskShapeOnSave } from '../invariants.js';
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
  const taskId = makeTaskId(newUuid());
  const task = {
    id: taskId,
    createdAt: new Date().toISOString(),
    ...args,
    kind: 'tool' as const,  // placed last to prevent spread override
  };
  // phase 239 Step A: schema invariant check（audit optional 时 skip、防 wrap audit 调用）
  if (audit) {
    assertTaskShapeOnSave(task, audit, 'schedule_tool');
  }

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
      isShadow: args.callerLabel === 'shadow',
    });
  }
  return taskId;
}
