import { describe, expect, it } from 'vitest';
import { encodeAuditArtifact, encodeAuditLoss } from '../../../src/foundation/audit/index.js';

const sha256 = 'a'.repeat(64);

describe('AuditLog artifact and loss encoding contract', () => {
  it('encodes a complete owner artifact as stable named columns', () => {
    expect(encodeAuditArtifact({
      owner: 'command_tool',
      ref: 'artifacts/output.txt',
      sha256,
      bytes: 42,
      schemaVersion: 1,
      partial: false,
    })).toEqual([
      'artifact_owner=command_tool',
      'artifact_ref=artifacts/output.txt',
      `artifact_sha256=${sha256}`,
      'artifact_bytes=42',
      'artifact_schema_version=1',
      'artifact_partial=false',
    ]);
  });

  it('encodes an explicit unrecoverable loss policy without inventing an artifact', () => {
    expect(encodeAuditLoss({
      source: 'provider_response.blocks',
      amount: 2,
      unit: 'blocks',
      reason: 'unsupported_provider_shape',
      policyVersion: 1,
      recoverable: false,
    })).toEqual([
      'loss_source=provider_response.blocks',
      'loss_amount=2',
      'loss_unit=blocks',
      'loss_reason=unsupported_provider_shape',
      'loss_policy_version=1',
      'loss_recoverable=false',
    ]);
  });

  it('appends a recoverable artifact to a loss record', () => {
    const cols = encodeAuditLoss({
      source: 'stream.repair',
      amount: 10,
      unit: 'bytes',
      reason: 'trailing_partial_event',
      policyVersion: 1,
      recoverable: true,
      artifact: {
        owner: 'stream',
        ref: 'stream/repair.bin',
        sha256,
        bytes: 10,
        schemaVersion: 1,
        partial: true,
      },
    });
    expect(cols).toContain('loss_recoverable=true');
    expect(cols).toContain('artifact_partial=true');
  });

  it.each([
    () => encodeAuditArtifact({ owner: '', ref: 'x', sha256, bytes: 1, schemaVersion: 1, partial: false }),
    () => encodeAuditArtifact({ owner: 'x', ref: 'x', sha256: 'bad', bytes: 1, schemaVersion: 1, partial: false }),
    () => encodeAuditArtifact({ owner: 'x', ref: 'x', sha256, bytes: -1, schemaVersion: 1, partial: false }),
    () => encodeAuditLoss({ source: 'x', amount: 1, unit: 'invalid' as never, reason: 'x', policyVersion: 1, recoverable: false }),
  ])('rejects malformed reference or loss values', (encode) => {
    expect(encode).toThrow();
  });
});
