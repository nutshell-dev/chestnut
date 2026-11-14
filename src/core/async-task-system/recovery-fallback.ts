import { formatErr, newUuid } from '../../foundation/node-utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { InboxMessage } from '../../foundation/messaging/index.js';
import { writeInboxAsync } from '../../foundation/messaging/index.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { emitRecoveryFailed } from './audit-emit.js';
import { TASKS_QUEUES_RESULTS_DIR } from './dirs.js';
import type { ProcessedTaskResult, SendFallbackResult, WriteInboxAsync } from './result-delivery-types.js';
import type { FullTaskId, SubAgentTask, ToolTask } from './types.js';
import { taskShortId } from './types.js';

export const RECOVERY_NOTICE_MAX_ITEMS = 20;
export const RECOVERY_NOTICE_MAX_BYTES = 32 * 1024;
export const RECOVERY_FALLBACK_FILE = 'recovery-fallback.json';
export const RECOVERY_BATCH_DIR = `${TASKS_QUEUES_RESULTS_DIR}/recovery-batches`;

export interface RecoveryNoticeItem {
  taskId: string;
  fullTaskId: FullTaskId;
  is_error: boolean;
  reason: string;
  resultRef: string;
}

export interface RecoveryNotice {
  schema_version: 1;
  batchId: string;
  parentClawId: string;
  createdAt: string;
  aggregated: true;
  partial: boolean;
  omittedCount: number;
  items: RecoveryNoticeItem[];
}

export interface PendingRecoveryNotice {
  parentClawId: string;
  item: RecoveryNoticeItem;
  onDelivered: () => Promise<void>;
  onFailed: (error: unknown) => Promise<void>;
}

export interface RecoveryFallbackPass {
  add(entry: PendingRecoveryNotice): void;
  flush(): Promise<void>;
}

interface RecoveryFallbackPassDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  writeInboxAsync?: WriteInboxAsync;
}

function makeNotice(
  parentClawId: string,
  items: RecoveryNoticeItem[],
  total: number,
  partial: boolean,
  batchId = 'batch',
  createdAt = '0000-00-00T00:00:00.000Z',
): RecoveryNotice {
  return {
    schema_version: 1,
    batchId,
    parentClawId,
    createdAt,
    aggregated: true,
    partial,
    omittedCount: total - items.length,
    items,
  };
}

/** Stable, lossless item/UTF-8-byte chunking for one parent recovery pass. */
export function chunkRecoveryNoticeItems(
  parentClawId: string,
  entries: readonly PendingRecoveryNotice[],
): PendingRecoveryNotice[][] {
  const sorted = [...entries].sort((a, b) => a.item.fullTaskId.localeCompare(b.item.fullTaskId));
  const chunks: PendingRecoveryNotice[][] = [];
  let current: PendingRecoveryNotice[] = [];
  for (const entry of sorted) {
    const candidate = [...current, entry];
    const tooMany = candidate.length > RECOVERY_NOTICE_MAX_ITEMS;
    const tooLarge = Buffer.byteLength(JSON.stringify(makeNotice(
      parentClawId,
      candidate.map(e => e.item),
      sorted.length,
      sorted.length > RECOVERY_NOTICE_MAX_ITEMS,
    )), 'utf8') > RECOVERY_NOTICE_MAX_BYTES;
    if (current.length > 0 && (tooMany || tooLarge)) {
      chunks.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function createRecoveryFallbackPass(deps: RecoveryFallbackPassDeps): RecoveryFallbackPass {
  const pending: PendingRecoveryNotice[] = [];
  return {
    add(entry) {
      pending.push(entry);
    },
    async flush() {
      const byParent = new Map<string, PendingRecoveryNotice[]>();
      for (const entry of pending) {
        const entries = byParent.get(entry.parentClawId) ?? [];
        entries.push(entry);
        byParent.set(entry.parentClawId, entries);
      }
      for (const [parentClawId, entries] of [...byParent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const chunks = chunkRecoveryNoticeItems(parentClawId, entries);
        for (const chunk of chunks) {
          const batchId = newUuid();
          const notice = makeNotice(
            parentClawId,
            chunk.map(e => e.item),
            entries.length,
            chunks.length > 1,
            batchId,
            new Date().toISOString(),
          );
          const manifestPath = `${RECOVERY_BATCH_DIR}/${batchId}.json`;
          try {
            await deps.fs.ensureDir(RECOVERY_BATCH_DIR);
            await deps.fs.writeAtomic(manifestPath, JSON.stringify(notice, null, 2));
          } catch (err) {
            emitRecoveryFailed(deps.auditWriter, {
              context: 'recovery_fallback_manifest_failed',
              error: formatErr(err),
            });
            for (const entry of chunk) await entry.onFailed(err);
            continue;
          }
          const message: InboxMessage = {
            id: batchId,
            type: 'task_result',
            from: 'system',
            to: parentClawId,
            content: JSON.stringify(notice),
            priority: chunk.some(e => e.item.is_error) ? 'high' : 'normal',
            timestamp: notice.createdAt,
          };
          try {
            await (deps.writeInboxAsync ?? writeInboxAsync)(deps.fs, '.', message, deps.auditWriter);
          } catch (err) {
            emitRecoveryFailed(deps.auditWriter, {
              context: 'recovery_fallback_inbox_failed',
              error: formatErr(err),
            });
            for (const entry of chunk) await entry.onFailed(err);
            continue;
          }
          deps.auditWriter.write(
            TASK_AUDIT_EVENTS.RECOVERY_FALLBACK_BATCH,
            `batchId=${batchId}`,
            `parentClawId=${parentClawId}`,
            `items=${chunk.length}`,
            `partial=${notice.partial}`,
            `manifest=${manifestPath}`,
          );
          for (const entry of chunk) {
            try {
              await entry.onDelivered();
            } catch (err) {
              emitRecoveryFailed(deps.auditWriter, {
                taskId: entry.item.fullTaskId,
                context: 'recovery_fallback_settlement_failed',
                error: formatErr(err),
              });
            }
          }
        }
      }
    },
  };
}

export interface QueueRecoveryFallbackDeps extends RecoveryFallbackPassDeps {
  sendFallbackResult?: SendFallbackResult<SubAgentTask | ToolTask>;
  recoveryFallbackPass?: RecoveryFallbackPass;
}

/**
 * Persist the complete per-task fallback before queueing its derived notice.
 * A custom fallback sender remains an alternate delivery owner and is not
 * silently wrapped by the default recovery aggregator.
 */
export async function queueRecoveryFallback(
  deps: QueueRecoveryFallbackDeps,
  task: SubAgentTask | ToolTask,
  result: ProcessedTaskResult,
  reason: string,
  onDelivered: () => Promise<void>,
  onFailed: (error: unknown) => Promise<void> = async () => { /* caller retains running */ },
): Promise<boolean> {
  if (deps.recoveryFallbackPass === undefined || deps.sendFallbackResult !== undefined) return false;
  const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
  const resultRef = `${resultDir}/${RECOVERY_FALLBACK_FILE}`;
  try {
    await deps.fs.ensureDir(resultDir);
    await deps.fs.writeAtomic(resultRef, JSON.stringify({
      schema_version: 1,
      taskId: taskShortId(task),
      fullTaskId: task.id,
      reason,
      result,
    }, null, 2));
  } catch (err) {
    emitRecoveryFailed(deps.auditWriter, {
      taskId: task.id,
      context: 'recovery_fallback_artifact_failed',
      error: formatErr(err),
    });
    await onFailed(err);
    return true;
  }
  const item: RecoveryNoticeItem = {
    taskId: taskShortId(task),
    fullTaskId: task.id as FullTaskId,
    is_error: result.isError,
    reason,
    resultRef,
  };
  const entry: PendingRecoveryNotice = {
    parentClawId: task.parentClawId,
    item,
    onDelivered,
    onFailed,
  };
  deps.recoveryFallbackPass.add(entry);
  return true;
}
