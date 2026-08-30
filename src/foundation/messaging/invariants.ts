/**
 * messaging InboxMessage / OutboxMessage write 端 schema invariant。
 *
 * 应然 anchor（per design/modules/l2_messaging.md §「persist-state observability」、phase 273 Step A）：
 * - DP1 信息不丢失：message 是 claw 间通信权威载体、shape 漂 = 通信信息丢
 * - DP2 不静默丢弃：违例 emit audit 消除静默
 * - DP3/DP5 状态可观察 + 凭日志记录重建：违例显式可观察
 *
 * 共享 helper、kind ∈ {inbox, outbox} 分流走 message-type 特化 sub-check。
 *
 * 共用 5 sub-check：
 * - id: string + 非空
 * - from: string
 * - to: string
 * - content: string
 * - priority: ∈ Priority union
 * - timestamp: ISO 8601 timestamp 形态
 *
 * inbox 特化：type: string（11+ union + string fallback）
 * outbox 特化：type: ∈ {'report', 'question', 'result', 'error'}（4 值 union）
 *
 * 不 throw（DP1 + Path #4 防 break write 路径、保 IO 错 throw 业务路径）。
 */

import type { AuditLog } from '../audit/index.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';

type MessageKind = 'inbox' | 'outbox';
export type MessageDirection = 'write';   // 留 future 扩 'read'

// 与 types.ts Priority union 同源；改 union 时同步
const VALID_PRIORITIES: ReadonlySet<string> = new Set(['low', 'normal', 'high', 'critical']);
// 与 types.ts OutboxMessage.type union 同源；改 union 时同步
const VALID_OUTBOX_TYPES: ReadonlySet<string> = new Set(['report', 'question', 'result', 'error']);
const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function assertMessageShape(
  message: unknown,
  audit: AuditLog,
  kind: MessageKind,
  direction: MessageDirection,
): void {
  if (typeof message !== 'object' || message === null) {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`,
      `sub_check=message_not_object`, `actual=${typeof message}`,
    );
    return;
  }
  const m = message as Record<string, unknown>;
  const idForLog = typeof m.id === 'string' ? m.id : 'unknown';

  checkId(m, audit, kind, direction);
  checkFrom(m, audit, kind, direction, idForLog);
  checkTo(m, audit, kind, direction, idForLog);
  checkContent(m, audit, kind, direction, idForLog);
  checkPriority(m, audit, kind, direction, idForLog);
  checkTimestamp(m, audit, kind, direction, idForLog);
  checkType(m, audit, kind, direction, idForLog);
}

function checkId(m: Record<string, unknown>, audit: AuditLog, kind: MessageKind, direction: MessageDirection): void {
  if (typeof m.id !== 'string') {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=id_not_string`, `actual=${typeof m.id}`,
    );
  } else if (m.id.length === 0) {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=id_empty`,
    );
  }
}

function checkFrom(m: Record<string, unknown>, audit: AuditLog, kind: MessageKind, direction: MessageDirection, id: string): void {
  if (typeof m.from !== 'string') {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=from_not_string`,
      `id=${id}`, `actual=${typeof m.from}`,
    );
  }
}

function checkTo(m: Record<string, unknown>, audit: AuditLog, kind: MessageKind, direction: MessageDirection, id: string): void {
  if (typeof m.to !== 'string') {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=to_not_string`,
      `id=${id}`, `actual=${typeof m.to}`,
    );
  }
}

function checkContent(m: Record<string, unknown>, audit: AuditLog, kind: MessageKind, direction: MessageDirection, id: string): void {
  if (typeof m.content !== 'string') {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=content_not_string`,
      `id=${id}`, `actual=${typeof m.content}`,
    );
  }
}

function checkPriority(m: Record<string, unknown>, audit: AuditLog, kind: MessageKind, direction: MessageDirection, id: string): void {
  if (typeof m.priority !== 'string' || !VALID_PRIORITIES.has(m.priority)) {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=priority_not_in_union`,
      `id=${id}`, `actual=${String(m.priority)}`,
    );
  }
}

function checkTimestamp(m: Record<string, unknown>, audit: AuditLog, kind: MessageKind, direction: MessageDirection, id: string): void {
  if (typeof m.timestamp !== 'string') {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=timestamp_not_string`,
      `id=${id}`, `actual=${typeof m.timestamp}`,
    );
    return;
  }
  if (!ISO_TIMESTAMP_REGEX.test(m.timestamp)) {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=timestamp_not_iso`,
      `id=${id}`, `actual=${m.timestamp}`,
    );
  }
}

function checkType(m: Record<string, unknown>, audit: AuditLog, kind: MessageKind, direction: MessageDirection, id: string): void {
  if (typeof m.type !== 'string') {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=type_not_string`,
      `id=${id}`, `actual=${typeof m.type}`,
    );
    return;
  }
  if (kind === 'outbox' && !VALID_OUTBOX_TYPES.has(m.type)) {
    audit.write(
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      `kind=${kind}`, `direction=${direction}`, `sub_check=outbox_type_not_in_union`,
      `id=${id}`, `actual=${m.type}`,
    );
  }
  // inbox: type 是 11+ union + string fallback、不强制 union check（业务允许 future extension）
}
