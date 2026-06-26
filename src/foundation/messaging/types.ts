
export type Priority = 'low' | 'normal' | 'high' | 'critical';

export const PRIORITY_VALUES: Record<Priority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

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

export interface InboxHandle {
  readonly filePath: string;
  readonly originalFileName: string;
}

export interface HeartbeatEntry {
  claw_id: string;
  timestamp: string;
  status: 'idle' | 'working' | 'error';
  current_contract?: string;
  message_count: number;
  memory_usage?: number;
}
