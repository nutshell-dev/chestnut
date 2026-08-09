import type { AuditArtifactRef, AuditLossRecord } from './types.js';

const LOSS_UNITS = new Set<AuditLossRecord['unit']>([
  'bytes',
  'chars',
  'rows',
  'blocks',
  'events',
]);

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`audit ${field} must be non-empty`);
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`audit ${field} must be a non-negative safe integer`);
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`audit ${field} must be a positive safe integer`);
  }
}

export function encodeAuditArtifact(ref: AuditArtifactRef): string[] {
  requireNonEmpty(ref.owner, 'artifact owner');
  requireNonEmpty(ref.ref, 'artifact ref');
  if (!/^[a-f0-9]{64}$/i.test(ref.sha256)) {
    throw new Error('audit artifact sha256 must be 64 hexadecimal characters');
  }
  requireNonNegativeInteger(ref.bytes, 'artifact bytes');
  requirePositiveInteger(ref.schemaVersion, 'artifact schemaVersion');

  return [
    `artifact_owner=${ref.owner}`,
    `artifact_ref=${ref.ref}`,
    `artifact_sha256=${ref.sha256.toLowerCase()}`,
    `artifact_bytes=${ref.bytes}`,
    `artifact_schema_version=${ref.schemaVersion}`,
    `artifact_partial=${ref.partial}`,
  ];
}

export function encodeAuditLoss(record: AuditLossRecord): string[] {
  requireNonEmpty(record.source, 'loss source');
  requireNonEmpty(record.reason, 'loss reason');
  requireNonNegativeInteger(record.amount, 'loss amount');
  requirePositiveInteger(record.policyVersion, 'loss policyVersion');
  if (!LOSS_UNITS.has(record.unit)) throw new Error(`audit loss unit is invalid: ${record.unit}`);

  return [
    `loss_source=${record.source}`,
    `loss_amount=${record.amount}`,
    `loss_unit=${record.unit}`,
    `loss_reason=${record.reason}`,
    `loss_policy_version=${record.policyVersion}`,
    `loss_recoverable=${record.recoverable}`,
    ...(record.artifact ? encodeAuditArtifact(record.artifact) : []),
  ];
}
