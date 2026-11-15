/**
 * @module L4.ContractSystem.CancellationDeliveryStore
 * Durable cancellation delivery and execution-stop evidence.
 *
 * The record is written before the lifecycle rename.  It is therefore possible
 * to recover a cancellation that crashed after the rename but before its first
 * notification attempt.  Delivery identity is contract-scoped and stable across
 * committed/already_committed retries; the lifecycle intent id remains evidence
 * for the owner terminal transition.
 */

import * as path from 'path';
import type { AuditLog } from '../../foundation/audit/index.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { CONTRACT_CANCELLATION_DELIVERY_DIR } from './dirs.js';
import type { ContractId } from './types.js';

export const CONTRACT_CANCELLATION_DELIVERY_META_KEY = 'contract_cancellation_delivery_id';

export type CancellationDeliveryState =
  | { readonly kind: 'pending'; readonly updatedAt: string }
  | { readonly kind: 'message_written'; readonly updatedAt: string }
  | {
      readonly kind: 'unknown';
      readonly updatedAt: string;
      readonly stage: 'terminal_query' | 'delivery';
      readonly error: string;
    }
  | { readonly kind: 'confirmed'; readonly updatedAt: string };

export type CancellationStopState =
  | { readonly kind: 'stop_requested'; readonly updatedAt: string }
  | { readonly kind: 'stop_unknown'; readonly updatedAt: string; readonly reason: string }
  | {
      readonly kind: 'stop_confirmed';
      readonly updatedAt: string;
      readonly evidence: 'abort' | 'worker_stopped';
    };

export interface CancellationDeliveryRecord {
  readonly schema_version: 1;
  readonly contractId: ContractId;
  readonly intentId: string;
  readonly deliveryId: string;
  readonly reason: string;
  readonly requestedAt?: string;
  readonly delivery: CancellationDeliveryState;
  readonly stop: CancellationStopState;
}

export interface CancellationDeliveryStore {
  load(contractId: ContractId): Promise<CancellationDeliveryRecord | null>;
  list(): Promise<readonly CancellationDeliveryRecord[]>;
  save(record: CancellationDeliveryRecord): Promise<void>;
}

function assertRecordId(value: string, field: string): void {
  if (
    value.length === 0 || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')
  ) {
    throw new TypeError(`cancellation delivery record: invalid ${field}`);
  }
}

export function cancellationDeliveryId(contractId: ContractId): string {
  assertRecordId(contractId, 'contractId');
  // v2 deliberately cannot alias the legacy, unkeyed cancellation envelope id.
  return `contract:${contractId}:cancelled:v2`;
}

export function newCancellationDeliveryRecord(
  contractId: ContractId,
  intentId: string,
  reason: string,
): CancellationDeliveryRecord {
  assertRecordId(contractId, 'contractId');
  assertRecordId(intentId, 'intentId');
  const updatedAt = new Date().toISOString();
  return {
    schema_version: 1,
    contractId,
    intentId,
    deliveryId: cancellationDeliveryId(contractId),
    reason,
    requestedAt: updatedAt,
    delivery: { kind: 'pending', updatedAt },
    stop: { kind: 'stop_requested', updatedAt },
  };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseDelivery(raw: unknown): CancellationDeliveryState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!isTimestamp(value.updatedAt)) return null;
  const base = { updatedAt: value.updatedAt };
  switch (value.kind) {
    case 'pending':
    case 'message_written':
      return { ...base, kind: value.kind };
    case 'unknown':
      if (
        (value.stage !== 'terminal_query' && value.stage !== 'delivery') ||
        typeof value.error !== 'string' || value.error.length === 0
      ) return null;
      return { ...base, kind: 'unknown', stage: value.stage, error: value.error };
    case 'confirmed':
      return { ...base, kind: 'confirmed' };
    default:
      return null;
  }
}

function parseStop(raw: unknown): CancellationStopState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!isTimestamp(value.updatedAt)) return null;
  const base = { updatedAt: value.updatedAt };
  switch (value.kind) {
    case 'stop_requested':
      return { ...base, kind: 'stop_requested' };
    case 'stop_unknown':
      if (typeof value.reason !== 'string' || value.reason.length === 0) return null;
      return { ...base, kind: 'stop_unknown', reason: value.reason };
    case 'stop_confirmed':
      if (value.evidence !== 'abort' && value.evidence !== 'worker_stopped') return null;
      return { ...base, kind: 'stop_confirmed', evidence: value.evidence };
    default:
      return null;
  }
}

export function parseCancellationDeliveryRecord(raw: unknown): CancellationDeliveryRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.schema_version !== 1 ||
    typeof value.contractId !== 'string' || value.contractId.length === 0 ||
    typeof value.intentId !== 'string' || value.intentId.length === 0 ||
    typeof value.deliveryId !== 'string' || value.deliveryId.length === 0 ||
    typeof value.reason !== 'string'
  ) return null;
  const delivery = parseDelivery(value.delivery);
  const stop = parseStop(value.stop);
  if (!delivery || !stop) return null;
  if (value.deliveryId !== cancellationDeliveryId(value.contractId as ContractId)) return null;
  return {
    schema_version: 1,
    contractId: value.contractId as ContractId,
    intentId: value.intentId,
    deliveryId: value.deliveryId,
    reason: value.reason,
    ...(typeof value.requestedAt === 'string' ? { requestedAt: value.requestedAt } : {}),
    delivery,
    stop,
  };
}

function recordPath(contractId: ContractId): string {
  assertRecordId(contractId, 'contractId');
  return path.join(CONTRACT_CANCELLATION_DELIVERY_DIR, `${contractId}.json`);
}

export function createCancellationDeliveryStore(deps: {
  fs: FileSystem;
  audit: AuditLog;
}): CancellationDeliveryStore {
  const { fs, audit } = deps;

  const parse = (raw: string, contractId: ContractId): CancellationDeliveryRecord => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      throw new Error(`cancellation delivery record parse failed (${contractId})`, { cause: error });
    }
    const record = parseCancellationDeliveryRecord(decoded);
    if (!record || record.contractId !== contractId) {
      throw new Error(`cancellation delivery record schema/identity invalid (${contractId})`);
    }
    return record;
  };

  return {
    async load(contractId) {
      let raw: string;
      try {
        raw = await fs.read(recordPath(contractId));
      } catch (error) {
        if (isFileNotFound(error)) return null;
        throw error;
      }
      return parse(raw, contractId);
    },

    async list() {
      let entries;
      try {
        entries = await fs.list(CONTRACT_CANCELLATION_DELIVERY_DIR, { includeDirs: false });
      } catch (error) {
        if (isFileNotFound(error)) return [];
        throw error;
      }
      const records: CancellationDeliveryRecord[] = [];
      for (const entry of entries) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
        const contractId = makeRecordContractId(entry.name);
        const raw = await fs.read(path.join(CONTRACT_CANCELLATION_DELIVERY_DIR, entry.name));
        records.push(parse(raw, contractId));
      }
      records.sort((a, b) => a.contractId.localeCompare(b.contractId));
      return records;
    },

    async save(record) {
      // Write-ahead evidence: a crash may leave audit ahead of the record, never
      // a state transition without a reconstructible full next_record payload.
      audit.write(
        CONTRACT_AUDIT_EVENTS.CANCELLATION_DELIVERY_TRANSITION,
        `contract=${record.contractId}`,
        `intent_id=${record.intentId}`,
        `delivery_id=${record.deliveryId}`,
        `delivery_state=${record.delivery.kind}`,
        `stop_state=${record.stop.kind}`,
        `next_record=${JSON.stringify(record)}`,
      );
      const result = await fs.writeAtomic(recordPath(record.contractId), JSON.stringify(record, null, 2));
      if (result.kind !== 'durable') {
        audit.write(
          CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
          'notify_type=contract_cancelled',
          'context=cancellation_delivery_store',
          `contract=${record.contractId}`,
          `delivery_id=${record.deliveryId}`,
          `durability=${result.kind}`,
          `error=${formatErr(result.error)}`,
        );
      }
    },
  };
}

function makeRecordContractId(fileName: string): ContractId {
  const contractId = fileName.slice(0, -'.json'.length);
  assertRecordId(contractId, 'contractId');
  return contractId as ContractId;
}
