
export type Priority = 'low' | 'normal' | 'high' | 'critical';

export const PRIORITY_VALUES: Record<Priority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

// 派生：keys 声明顺序即 CLI 渲染/校验顺序（critical/high/normal/low，与现状 help 一致）。
export const PRIORITY_ORDER = Object.keys(PRIORITY_VALUES) as readonly Priority[];

export interface InboxMessage {
  id: string;
  type: string;
  from: string;
  to: string;
  content: string;
  priority: Priority;
  timestamp: string;
  reply_to?: string;
  metadata?: Record<string, string>;
  extraMeta?: Record<string, string>;
}

/** Non-consuming inbox peek outcome; absence is distinct from unavailable I/O. */
export type InboxPeekResult<T> =
  | { kind: 'empty'; value: T }
  | { kind: 'found'; value: T }
  | {
      kind: 'unavailable';
      stage: 'list' | 'read' | 'stat' | 'decode';
      path: string;
      error: unknown;
    };

export interface OutboxMessage {
  id: string;
  type: 'report' | 'question' | 'result' | 'error';
  from: string;
  to: string;
  content: string;
  timestamp: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  in_reply_to?: string;
  metadata?: Record<string, string>;
}

/** Pending outbox listing: a missing directory is empty; other I/O failures are explicit. */
export type OutboxListResult =
  | { kind: 'empty'; files: [] }
  | { kind: 'found'; files: string[] }
  | { kind: 'failed'; stage: 'list'; path: string; error: unknown };

/** Startup recovery outcome; degraded initialization must be handled by the caller. */
export type OutboxInitResult =
  | { kind: 'ready'; recovered: number }
  | {
      kind: 'degraded';
      stage: 'ensure_dir' | 'list' | 'read' | 'move';
      path: string;
      error: unknown;
      recovered: number;
    };

declare const OutboxClaimHandleBrand: unique symbol;

/**
 * Opaque, reader-minted claim identity. Runtime settlement additionally requires
 * the exact object minted by the same reader, not merely this structural type.
 */
export type OutboxClaimHandle = {
  readonly claimPath: string;
  readonly filename: string;
  readonly [OutboxClaimHandleBrand]: true;
  markDone(): Promise<void>;
  markSkipped(): Promise<void>;
  markFailed(error: unknown): Promise<void>;
};

declare const InboxHandleBrand: unique symbol;

/**
 * Opaque branded handle for an inflight inbox message.
 *
 * Handles are minted only by InboxReader.drainAndDeliver() and validated
 * on ack/nack/markMisrouted to enforce path containment.
 */
export type InboxHandle = {
  readonly filePath: string;
  readonly originalFileName: string;
  readonly [InboxHandleBrand]: true;
};

/**
 * Phase 1781: inbox init recovery outcome.
 *
 * init() 的 startup reconcile（inflight → pending 恢复）失败不得伪装为成功初始化：
 * - `ready`：恢复扫描完成（含零恢复），`recovered` = 实际恢复条数。
 * - `degraded`：list/read/move 任一失败；携带首个失败的阶段、entry identity
 *   （inflight 内文件名，list 阶段失败时缺省）与原始 error。未恢复 entry 保留在
 *   inflight/ 原处（不丢、不重复处置），caller 必须显式处理（audit/降级继续或失败）。
 */
export type InboxInitResult =
  | { kind: 'ready'; recovered: number }
  | {
      kind: 'degraded';
      stage: 'list' | 'read' | 'move';
      entry?: string;
      error: unknown;
      recovered: number;
    };
