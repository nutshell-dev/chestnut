/**
 * @module L4.AsyncTaskSystem
 * phase 1243: AsyncTaskSystem 自家 inbox 消息 rendering declarations。
 *
 * 业务语义归 AsyncTaskSystem（pending queue + result-delivery 都是它的）.
 * 均使用标准 system presentation（body 由 sender 拼 self-contained framing）。
 */

import type { InboxMessageTypeDeclaration } from '../../foundation/messaging/index.js';

export const ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES = [
  { owner: 'async-task-system', type: 'task_queue_overflow', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'async-task-system', type: 'task_result', rendering: { kind: 'standard', presentation: 'system' } },
] as const satisfies readonly InboxMessageTypeDeclaration[];
