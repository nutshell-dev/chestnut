/**
 * @module L4.AsyncTaskSystem.ResultDeliveryTypes
 * Function-shape type aliases for result delivery.
 * Extracted in phase 1042 to break the cycle between types.ts and result-delivery.ts.
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { InboxMessage } from '../../foundation/messaging/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';

/** phase 1042: injected writeInboxAsync; falls back to the real implementation when absent. */
export interface ResultDeliveryDeps {
  writeInboxAsync?: WriteInboxAsync;
}

/** phase 1042: function shape for sending a subagent task result. */
export type SendResult<TTask> = (
  fs: FileSystem,
  auditWriter: AuditLog,
  task: TTask,
  result: string,
  isError: boolean,
  deps?: ResultDeliveryDeps,
) => Promise<void>;

/** phase 1042: function shape for sending a fallback error message. */
export type SendFallbackError<TTask> = (
  fs: FileSystem,
  auditWriter: AuditLog,
  task: TTask,
  errorMsg: string,
  deps?: ResultDeliveryDeps,
) => Promise<void>;

/** phase 1042: function shape for sending a tool task result. */
export type SendToolResult<TTask> = (
  fs: FileSystem,
  auditWriter: AuditLog,
  task: TTask,
  toolResult: ToolResult | string,
  isError: boolean,
  deps?: ResultDeliveryDeps,
) => Promise<void>;

/** phase 1042: function shape for writing an inbox message asynchronously. */
export type WriteInboxAsync = (
  fs: FileSystem,
  inboxDir: string,
  message: InboxMessage,
  audit: AuditLog,
) => Promise<void>;
