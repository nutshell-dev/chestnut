/**
 * Phase 1146 Step B: archive terminal time resolver tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { resolveArchiveTime } from '../../../src/core/contract/archive-time.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { ArchiveListEntry, ArchiveState, ContractId } from '../../../src/core/contract/types.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-archive-time-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
});

const contractId = 'cid-1' as ContractId;

function auditPath(): string {
  return path.join(clawDir, 'audit.tsv');
}

async function writeAudit(rows: string[]): Promise<void> {
  await fs.writeFile(auditPath(), rows.join('\n') + (rows.length > 0 ? '\n' : ''), 'utf-8');
}

function currentLocation(state: ArchiveState): ArchiveListEntry {
  return {
    contractId,
    kind: 'current',
    state,
    containerDir: `contract/archive/${state}`,
    contractRoot: `contract/archive/${state}/${contractId}`,
  };
}

function legacyLocation(): ArchiveListEntry {
  return {
    contractId,
    kind: 'legacy',
    containerDir: 'contract/archive',
    contractRoot: `contract/archive/${contractId}`,
  };
}

function terminalRow(state: ArchiveState, seq: number, idStyle: 'camel' | 'snake' = 'camel', ts = '2026-07-19T10:00:00.000Z'): string {
  const eventMap: Record<ArchiveState, string> = {
    completed: CONTRACT_AUDIT_EVENTS.COMPLETED,
    cancelled: CONTRACT_AUDIT_EVENTS.CANCELLED,
    corrupted: CONTRACT_AUDIT_EVENTS.CORRUPTED,
  };
  const idCol = idStyle === 'camel' ? `contractId=${contractId}` : `contract_id=${contractId}`;
  const extra = state === 'completed' ? '\ttitle=T\tclaw=test-claw' : '';
  return `${ts}\tseq=${seq}\t${eventMap[state]}\t${idCol}${extra}`;
}

function cancelAbortRow(seq: number): string {
  return `2026-07-19T10:00:00.000Z\tseq=${seq}\t${CONTRACT_AUDIT_EVENTS.CANCELLED}\tcontractId=${contractId}\tabort_verifier_failed=true`;
}

describe('resolveArchiveTime', () => {
  it('returns known time for completed terminal record', async () => {
    await writeAudit([terminalRow('completed', 5)]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('known');
    if (result.time.kind !== 'known') return;
    expect(result.time.recordedAt).toBe('2026-07-19T10:00:00.000Z');
    expect(result.time.epochMs).toBe(new Date('2026-07-19T10:00:00.000Z').getTime());
    expect(result.time.source).toBe('terminal_audit');
    expect(result.issues).toHaveLength(0);
  });

  it('returns known time for cancelled terminal record', async () => {
    await writeAudit([terminalRow('cancelled', 3)]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('cancelled'),
      contractId,
    });

    expect(result.time.kind).toBe('known');
    expect(result.issues).toHaveLength(0);
  });

  it('returns known time for corrupted terminal record', async () => {
    await writeAudit([terminalRow('corrupted', 4)]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('corrupted'),
      contractId,
    });

    expect(result.time.kind).toBe('known');
    expect(result.issues).toHaveLength(0);
  });

  it('matches snake_case contract_id terminal records', async () => {
    await writeAudit([terminalRow('completed', 1, 'snake')]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('known');
  });

  it('returns audit_file_missing when audit file does not exist', async () => {
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('audit_file_missing');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('audit_file_missing');
    expect(result.issues[0].contractId).toBe(contractId);
  });

  it('returns terminal_event_unavailable when no matching terminal record', async () => {
    await writeAudit([
      `2026-07-19T09:00:00.000Z\tseq=1\t${CONTRACT_AUDIT_EVENTS.CREATED}\tcontractId=${contractId}`,
    ]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('terminal_event_unavailable');
    expect(result.issues[0].code).toBe('terminal_event_unavailable');
  });

  it('excludes cancel abort-failure diagnostics from terminal match', async () => {
    await writeAudit([cancelAbortRow(1)]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('cancelled'),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('terminal_event_unavailable');
  });

  it('returns invalid_terminal_record for id conflict', async () => {
    await writeAudit([
      `2026-07-19T10:00:00.000Z\tseq=1\t${CONTRACT_AUDIT_EVENTS.COMPLETED}\tcontractId=${contractId}\tcontract_id=other-id`,
    ]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('invalid_terminal_record');
    expect(result.issues[0].code).toBe('invalid_terminal_record');
    expect(result.issues[0].detail).toContain('id_conflict');
  });

  it('returns invalid_terminal_record for malformed timestamp', async () => {
    await writeAudit([terminalRow('completed', 1, 'camel', 'not-a-date')]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('invalid_terminal_record');
    expect(result.issues[0].detail).toContain('invalid_timestamp');
  });

  it('returns ambiguous_terminal_records for duplicate terminal rows', async () => {
    await writeAudit([
      terminalRow('completed', 1),
      terminalRow('completed', 2, 'snake', '2026-07-19T10:01:00.000Z'),
    ]);
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('ambiguous_terminal_records');
    expect(result.issues[0].code).toBe('ambiguous_terminal_records');
    expect(result.issues[0].detail).toContain('seq=1');
    expect(result.issues[0].detail).toContain('seq=2');
  });

  it('returns legacy_state_unresolved for legacy archive entries', async () => {
    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: legacyLocation(),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('legacy_state_unresolved');
    expect(result.issues[0].code).toBe('legacy_state_unresolved');
  });

  it('returns audit_read_failed when stat throws', async () => {
    const error = new Error('EACCES');
    const failingFs = {
      __brand: 'FileSystem',
      existsSync: () => { throw error; },
    } as unknown as FileSystem;

    const result = await resolveArchiveTime({
      fs: failingFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('audit_read_failed');
    expect(result.issues[0].code).toBe('audit_read_failed');
    expect(result.issues[0].cause).toBe(error);
  });

  it('returns audit_read_failed when read throws', async () => {
    const error = new Error('EACCES');
    const failingFs = {
      __brand: 'FileSystem',
      existsSync: () => true,
      readSync: () => { throw error; },
    } as unknown as FileSystem;

    const result = await resolveArchiveTime({
      fs: failingFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('unknown');
    if (result.time.kind !== 'unknown') return;
    expect(result.time.reason).toBe('audit_read_failed');
    expect(result.issues[0].code).toBe('audit_read_failed');
    expect(result.issues[0].cause).toBe(error);
  });

  it('ignores id conflicts belonging to other contracts (Step D isolation)', async () => {
    await writeAudit([
      terminalRow('completed', 1),
      `2026-07-19T10:00:00.000Z\tseq=2\t${CONTRACT_AUDIT_EVENTS.COMPLETED}\tcontractId=cid-2\tcontract_id=cid-3`,
    ]);

    const result = await resolveArchiveTime({
      fs: nodeFs,
      auditPath: auditPath(),
      location: currentLocation('completed'),
      contractId,
    });

    expect(result.time.kind).toBe('known');
    if (result.time.kind !== 'known') return;
    expect(result.time.recordedAt).toBe('2026-07-19T10:00:00.000Z');
    expect(result.issues).toHaveLength(0);
  });
});
