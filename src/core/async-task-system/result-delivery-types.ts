/**
 * @module L4.AsyncTaskSystem.ResultDeliveryTypes
 * Function-shape type aliases for result delivery.
 * Extracted in phase 1042 to break the cycle between types.ts and result-delivery.ts.
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { InboxMessage } from '../../foundation/messaging/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';

/**
 * Phase 1396 Step J: authoritative processed task outcome.
 *
 * Once committed to disk, this envelope is the single source of truth for both
 * delivery content and terminal classification. Recovery resends exactly this
 * envelope without re-invoking the processor or reinterpreting the raw result.
 */
export interface ProcessedTaskResult {
  schema_version: 1;
  content: string;
  isError: boolean;
  metadata?: Record<string, string>;
}

/** phase 1042: injected writeInboxAsync; falls back to the real implementation when absent. */
export interface ResultDeliveryDeps {
  writeInboxAsync?: WriteInboxAsync;
}

/**
 * phase 1863 (AT-D12)：投递证据（统一形态）——投递状态在 lifecycle 可表达。
 * - `delivered`：本次投递已落 inbox（含 at-least-once 窗口语义标注）；
 * - `resend_window`：投递未完成但存在恢复重发窗口（任务留 running、由恢复扫描重投）；
 * - `failed`：投递失败且无自动重发窗口（携带 reason）。
 */
export interface DeliveryEvidence {
  readonly kind: 'delivered' | 'resend_window' | 'failed';
  /** at-least-once 窗口（marker 语义统一表达）。 */
  readonly atLeastOnceWindow?: boolean;
  readonly reason?: string;
}

/**
 * phase 1863 (AT-D12)：投递策略（两路径差异显式声明，非路径分支猜测）——
 * - `marker_before_delete`：subagent 路径——成功投递先写 SENT_MARKER（≥10ms 级 race
 *   窗口内重复投递由 marker 收敛；accepted-stable）；
 * - `idempotent_redeliver`：tool 路径——无 marker；恢复 re-queue、幂等由 caller 契约承担。
 */
export type DeliveryPolicy = 'marker_before_delete' | 'idempotent_redeliver';

/** phase 1042 / Phase 1396 Step J: function shape for sending a subagent task result. */
export type SendResult<TTask> = (
  fs: FileSystem,
  auditWriter: AuditLog,
  task: TTask,
  result: ProcessedTaskResult,
  deps?: ResultDeliveryDeps,
) => Promise<DeliveryEvidence>;

/**
 * Phase 1396 Step L: fallback delivery takes the full ProcessedTaskResult
 * envelope (content + isError + metadata) — the split (content, isError)
 * signature is retired. Same function shape as SendResult.
 */
export type SendFallbackResult<TTask> = SendResult<TTask>;

/** phase 1042: function shape for sending a tool task result. */
export type SendToolResult<TTask> = (
  fs: FileSystem,
  auditWriter: AuditLog,
  task: TTask,
  toolResult: ToolResult | string,
  isError: boolean,
  deps?: ResultDeliveryDeps,
) => Promise<DeliveryEvidence>;

/** phase 1042: function shape for writing an inbox message asynchronously. */
export type WriteInboxAsync = (
  fs: FileSystem,
  inboxDir: string,
  message: InboxMessage,
  audit: AuditLog,
) => Promise<void>;
