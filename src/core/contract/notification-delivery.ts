/**
 * @module L4.ContractSystem.NotificationDelivery
 * Durable, synchronous ContractNotification delivery.
 *
 * The standardized event is atomically persisted in pending/ before the sink is
 * called. A successful sink moves the same record to done/. Pending records are
 * replayed at boot; done records suppress duplicate sink calls and retain the
 * revision history needed by later events.
 */

import * as path from 'path';
import type { AuditLog } from '../../foundation/audit/index.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { emitContractNotifyFailed } from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { CONTRACT_NOTIFICATION_OUTBOX_DIR } from './dirs.js';
import type { ContractNotification, ContractNotificationSink } from './notification.js';

export type StandardizedContractNotification = ContractNotification & {
  readonly stateRevision: number;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly messageId: string;
};

interface NotificationOutboxRecord {
  readonly schema_version: 1;
  readonly event: StandardizedContractNotification;
}

interface ScannedRecord {
  readonly state: 'pending' | 'done';
  readonly path: string;
  readonly record: NotificationOutboxRecord;
}

export interface ContractNotificationDelivery {
  readonly emit: ContractNotificationSink;
  recover(): void;
}

const PENDING_DIR = path.join(CONTRACT_NOTIFICATION_OUTBOX_DIR, 'pending');
const DONE_DIR = path.join(CONTRACT_NOTIFICATION_OUTBOX_DIR, 'done');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidNotification(event: Record<string, unknown>): boolean {
  if (
    !isNonEmptyString(event.contractId) ||
    !Number.isSafeInteger(event.stateRevision) || (event.stateRevision as number) < 1 ||
    !isNonEmptyString(event.occurredAt) ||
    !isNonEmptyString(event.idempotencyKey) ||
    !isNonEmptyString(event.messageId)
  ) return false;

  switch (event.type) {
    case 'contract_created':
      return typeof event.title === 'string' &&
        typeof event.subtaskCount === 'number' && Number.isFinite(event.subtaskCount) &&
        typeof event.createdAt === 'string';
    case 'contract_completed':
      return typeof event.title === 'string' && typeof event.goal === 'string' &&
        typeof event.completedAt === 'string' && Array.isArray(event.subtasks) &&
        event.subtasks.every(subtask => isObject(subtask) &&
          typeof subtask.id === 'string' && typeof subtask.completedAt === 'string' &&
          typeof subtask.forceAccepted === 'boolean');
    case 'contract_cancelled':
      return typeof event.reason === 'string';
    case 'contract_failed':
      return typeof event.reason === 'string' && typeof event.evidenceRef === 'string' &&
        typeof event.producer === 'string';
    case 'subtask_completed':
      return typeof event.subtaskId === 'string' &&
        (event.forceAccepted === undefined || event.forceAccepted === true);
    case 'verification_failed':
      return typeof event.subtaskId === 'string' && typeof event.cause === 'string' &&
        typeof event.feedback === 'string' && typeof event.retryCount === 'number' &&
        Number.isFinite(event.retryCount) && typeof event.maxAttempts === 'number' &&
        Number.isFinite(event.maxAttempts);
    default:
      return false;
  }
}

class MalformedNotificationOutboxRecord extends Error {}

function parseRecord(raw: string): NotificationOutboxRecord {
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!isObject(decoded) || decoded.schema_version !== 1 || !isObject(decoded.event) ||
        !isValidNotification(decoded.event)) {
      throw new Error('invalid notification outbox record');
    }
    return decoded as unknown as NotificationOutboxRecord;
  } catch (error) {
    throw new MalformedNotificationOutboxRecord('invalid notification outbox record', { cause: error });
  }
}

function recordPath(state: 'pending' | 'done', messageId: string): string {
  return path.join(state === 'pending' ? PENDING_DIR : DONE_DIR, `${encodeURIComponent(messageId)}.json`);
}

function eventIdentity(event: ContractNotification): { messageId: string; idempotencyKey: string } {
  let suffix = event.type;
  if (event.type === 'subtask_completed') suffix += `:${event.subtaskId}`;
  if (event.type === 'verification_failed') suffix += `:${event.subtaskId}:${event.retryCount}`;
  const idempotencyKey = event.idempotencyKey ?? `contract:${event.contractId}:${suffix}`;
  return { messageId: event.messageId ?? idempotencyKey, idempotencyKey };
}

export function createContractNotificationDelivery(deps: {
  fs: FileSystem;
  audit: AuditLog;
  sink: ContractNotificationSink;
}): ContractNotificationDelivery {
  const { fs, audit, sink } = deps;
  let revisions: Map<string, number> | undefined;

  const auditMalformed = (filePath: string, error: unknown): void => {
    audit.write(
      CONTRACT_AUDIT_EVENTS.NOTIFICATION_OUTBOX_MALFORMED,
      `path=${filePath}`,
      `error=${formatErr(error)}`,
    );
  };

  const readRecord = (filePath: string): NotificationOutboxRecord | null => {
    let raw: string;
    try {
      raw = fs.readSync(filePath);
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
    return parseRecord(raw);
  };

  const scan = (): { records: ScannedRecord[]; complete: boolean } => {
    const records: ScannedRecord[] = [];
    let complete = true;
    for (const state of ['pending', 'done'] as const) {
      const dir = state === 'pending' ? PENDING_DIR : DONE_DIR;
      let entries;
      try {
        entries = fs.listSync(dir, { includeDirs: false });
      } catch (error) {
        if (isFileNotFound(error)) continue;
        complete = false;
        emitContractNotifyFailed(audit, {
          notifyType: 'notification_outbox_scan',
          error: `${dir}: ${formatErr(error)}`,
        });
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(dir, entry.name);
        try {
          const record = readRecord(filePath);
          if (record) records.push({ state, path: filePath, record });
        } catch (error) {
          if (error instanceof MalformedNotificationOutboxRecord) {
            // Keep malformed evidence without preventing unrelated revisions.
            auditMalformed(filePath, error);
            continue;
          }
          complete = false;
          emitContractNotifyFailed(audit, {
            notifyType: 'notification_outbox_read',
            error: `${filePath}: ${formatErr(error)}`,
          });
        }
      }
    }
    return { records, complete };
  };

  const indexRevisions = (records: readonly ScannedRecord[]): Map<string, number> => {
    const indexed = new Map<string, number>();
    for (const { record } of records) {
      const event = record.event;
      indexed.set(event.contractId, Math.max(indexed.get(event.contractId) ?? 0, event.stateRevision));
    }
    return indexed;
  };

  const nextRevision = (contractId: string): number => {
    if (!revisions) {
      const scanned = scan();
      if (!scanned.complete) throw new Error('notification outbox scan failed; revision not allocated');
      revisions = indexRevisions(scanned.records);
    }
    return (revisions.get(contractId) ?? 0) + 1;
  };

  const persistPending = (record: NotificationOutboxRecord): void => {
    const result = fs.writeAtomicSync(recordPath('pending', record.event.messageId), JSON.stringify(record, null, 2));
    if (result.kind !== 'durable') {
      emitContractNotifyFailed(audit, {
        notifyType: record.event.type,
        error: `notification_outbox_durability=${result.kind}: ${formatErr(result.error)}`,
      });
    }
  };

  const deliver = (record: NotificationOutboxRecord, pendingPath: string): void => {
    sink(record.event);
    fs.moveSync(pendingPath, recordPath('done', record.event.messageId));
  };

  const emit: ContractNotificationSink = event => {
    const identity = eventIdentity(event);
    const donePath = recordPath('done', identity.messageId);
    if (readRecord(donePath)) return;

    const pendingPath = recordPath('pending', identity.messageId);
    const pending = readRecord(pendingPath);
    if (pending) {
      deliver(pending, pendingPath);
      return;
    }

    const standardized = {
      ...event,
      ...identity,
      stateRevision: nextRevision(event.contractId),
      occurredAt: new Date().toISOString(),
    } as StandardizedContractNotification;
    const record: NotificationOutboxRecord = { schema_version: 1, event: standardized };
    // Write-ahead is intentionally synchronous: ContractNotificationSink keeps
    // its existing synchronous signature and the sink never runs without a
    // recoverable standardized event.
    persistPending(record);
    revisions?.set(event.contractId, standardized.stateRevision);
    deliver(record, pendingPath);
  };

  return {
    emit,
    recover(): void {
      const scanned = scan();
      if (!revisions && scanned.complete) revisions = indexRevisions(scanned.records);
      const pending = scanned.records
        .filter(entry => entry.state === 'pending')
        .sort((a, b) => a.record.event.stateRevision - b.record.event.stateRevision ||
          a.record.event.messageId.localeCompare(b.record.event.messageId));
      for (const entry of pending) {
        try {
          deliver(entry.record, entry.path);
        } catch (error) {
          emitContractNotifyFailed(audit, {
            notifyType: entry.record.event.type,
            error: `notification_outbox_replay: ${formatErr(error)}`,
          });
        }
      }
    },
  };
}
