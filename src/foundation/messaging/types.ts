
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
