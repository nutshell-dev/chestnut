/**
 * Pending subagent task file writer.
 *
 * Direct file-based scheduling primitive used by spawn / dispatch tools.
 * Eliminates SubagentSystem→AsyncTaskSystem runtime business semantic call.
 * Watcher (AsyncTaskSystem._ingestPendingFile) consumes the file asynchronously.
 */
import { randomUUID } from 'crypto';
import { TASKS_QUEUES_PENDING_DIR } from '../../../foundation/paths.js';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { SubAgentTask } from '../system.js';
import { TASK_AUDIT_EVENTS } from '../audit-events.js';

/**
 * Write a pending subagent task file. Watcher will pick it up.
 * @returns The generated taskId.
 */
export async function writePendingSubagentTaskFile(
  fs: FileSystem,
  audit: AuditLog | undefined,
  args: Omit<SubAgentTask, 'id' | 'createdAt'>,
): Promise<string> {
  const taskId = randomUUID();
  const task: SubAgentTask = {
    ...args,
    id: taskId,
    createdAt: new Date().toISOString(),
  };
  await fs.writeAtomic(
    `${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`,
    JSON.stringify(task, null, 2),
  );
  audit?.write(TASK_AUDIT_EVENTS.TASK_SCHEDULED, taskId, 'kind=subagent', `parent=${task.parentClawId}`);
  return taskId;
}
