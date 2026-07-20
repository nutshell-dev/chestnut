/**
 * Phase 1146 Step C: structured cross-claw archive query tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { queryArchiveContracts } from '../../../src/core/contract/archive-query.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { ArchiveState, ContractId } from '../../../src/core/contract/types.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

let chestnutDir: string;

beforeEach(async () => {
  chestnutDir = await createTempDir('test-archive-query-');
});

afterEach(async () => {
  await cleanupTempDir(chestnutDir);
});

function fsRoot(): NodeFileSystem {
  return new NodeFileSystem({ baseDir: chestnutDir });
}

function clawDir(clawId: string): string {
  return path.join(chestnutDir, 'claws', clawId);
}

function archiveDir(clawId: string, state: ArchiveState): string {
  return path.join(clawDir(clawId), 'contract', 'archive', state);
}

function legacyArchiveDir(clawId: string, contractId: string): string {
  return path.join(clawDir(clawId), 'contract', 'archive', contractId);
}

function auditPath(clawId: string): string {
  return path.join(clawDir(clawId), 'audit.tsv');
}

async function makeClaw(clawId: string): Promise<void> {
  await fs.mkdir(clawDir(clawId), { recursive: true });
}

async function writeCurrentArchive(
  clawId: string,
  state: ArchiveState,
  contractId: string,
): Promise<void> {
  const dir = path.join(archiveDir(clawId, state), contractId);
  await fs.mkdir(dir, { recursive: true });
}

async function writeLegacyArchive(
  clawId: string,
  contractId: string,
): Promise<void> {
  const dir = legacyArchiveDir(clawId, contractId);
  await fs.mkdir(dir, { recursive: true });
}

async function writeAudit(clawId: string, rows: string[]): Promise<void> {
  const file = auditPath(clawId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.join('\n') + (rows.length > 0 ? '\n' : ''), 'utf-8');
}

function terminalRow(contractId: string, state: ArchiveState, seq: number, ts: string): string {
  const eventMap: Record<ArchiveState, string> = {
    completed: CONTRACT_AUDIT_EVENTS.COMPLETED,
    cancelled: CONTRACT_AUDIT_EVENTS.CANCELLED,
    corrupted: CONTRACT_AUDIT_EVENTS.CORRUPTED,
  };
  const extra = state === 'completed' ? '\ttitle=T\tclaw=test-claw' : '';
  return `${ts}\tseq=${seq}\t${eventMap[state]}\tcontractId=${contractId}${extra}`;
}

describe('queryArchiveContracts', () => {
  it('returns empty result when claws directory is missing', async () => {
    const result = await queryArchiveContracts({ fs: fsRoot() });

    expect(result.entries).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
    expect(result.incomplete).toBe(false);
  });

  it('lists multi-claw current archive states with known times', async () => {
    await makeClaw('c1');
    await makeClaw('c2');
    await writeCurrentArchive('c1', 'completed', 'ct-1');
    await writeCurrentArchive('c2', 'cancelled', 'ct-2');
    await writeCurrentArchive('c2', 'corrupted', 'ct-3');
    await writeAudit('c1', [terminalRow('ct-1', 'completed', 1, '2026-07-19T10:00:00.000Z')]);
    await writeAudit('c2', [
      terminalRow('ct-2', 'cancelled', 1, '2026-07-19T11:00:00.000Z'),
      terminalRow('ct-3', 'corrupted', 2, '2026-07-19T12:00:00.000Z'),
    ]);

    const result = await queryArchiveContracts({ fs: fsRoot() });

    expect(result.entries).toHaveLength(3);
    expect(result.incomplete).toBe(false);
    expect(result.issues).toHaveLength(0);

    const byId = new Map(result.entries.map(e => [e.contractId, e]));
    expect(byId.get('ct-1' as ContractId)?.state).toBe('completed');
    expect(byId.get('ct-1' as ContractId)?.archiveTime.kind).toBe('known');
    expect(byId.get('ct-2' as ContractId)?.state).toBe('cancelled');
    expect(byId.get('ct-3' as ContractId)?.state).toBe('corrupted');
  });

  it('retains unknown entries and marks result incomplete', async () => {
    await makeClaw('c1');
    await writeCurrentArchive('c1', 'completed', 'ct-1');
    // no audit file -> audit_file_missing

    const result = await queryArchiveContracts({ fs: fsRoot() });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].archiveTime.kind).toBe('unknown');
    expect(result.entries[0].archiveTime.reason).toBe('audit_file_missing');
    expect(result.incomplete).toBe(true);
    expect(result.issues.some(i => i.code === 'audit_file_missing')).toBe(true);
  });

  it('filter is inclusive and drops only known entries outside range', async () => {
    await makeClaw('c1');
    await writeCurrentArchive('c1', 'completed', 'before');
    await writeCurrentArchive('c1', 'completed', 'inside');
    await writeCurrentArchive('c1', 'completed', 'after');
    await writeAudit('c1', [
      terminalRow('before', 'completed', 1, '2026-07-19T08:00:00.000Z'),
      terminalRow('inside', 'completed', 2, '2026-07-19T10:00:00.000Z'),
      terminalRow('after', 'completed', 3, '2026-07-19T12:00:00.000Z'),
    ]);

    const sinceMs = new Date('2026-07-19T09:00:00.000Z').getTime();
    const untilMs = new Date('2026-07-19T11:00:00.000Z').getTime();
    const result = await queryArchiveContracts({
      fs: fsRoot(),
      filter: { sinceMs, untilMs },
    });

    const ids = result.entries.map(e => e.contractId).sort();
    expect(ids).toEqual(['inside']);
    expect(result.incomplete).toBe(false);
  });

  it('keeps unknown entries regardless of filter', async () => {
    await makeClaw('c1');
    await writeCurrentArchive('c1', 'completed', 'known');
    await writeCurrentArchive('c1', 'completed', 'unknown');
    await writeAudit('c1', [terminalRow('known', 'completed', 1, '2026-07-19T08:00:00.000Z')]);
    // unknown entry has no audit match -> terminal_event_unavailable

    const result = await queryArchiveContracts({
      fs: fsRoot(),
      filter: { sinceMs: new Date('2026-07-19T09:00:00.000Z').getTime() },
    });

    const ids = result.entries.map(e => e.contractId).sort();
    expect(ids).toEqual(['unknown']);
    expect(result.incomplete).toBe(true);
  });

  it('returns legacy entries as legacy-unresolved', async () => {
    await makeClaw('c1');
    await writeLegacyArchive('c1', 'legacy-1');

    const result = await queryArchiveContracts({ fs: fsRoot() });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].state).toBe('legacy-unresolved');
    expect(result.entries[0].archiveTime.kind).toBe('unknown');
    expect(result.entries[0].archiveTime.reason).toBe('legacy_state_unresolved');
    expect(result.incomplete).toBe(true);
  });

  it('sorts entries by clawId, state, contractId', async () => {
    await makeClaw('b');
    await makeClaw('a');
    await writeCurrentArchive('b', 'corrupted', 'z');
    await writeCurrentArchive('a', 'completed', 'y');
    await writeCurrentArchive('a', 'cancelled', 'x');
    await writeAudit('b', [terminalRow('z', 'corrupted', 1, '2026-07-19T10:00:00.000Z')]);
    await writeAudit('a', [
      terminalRow('y', 'completed', 1, '2026-07-19T10:00:00.000Z'),
      terminalRow('x', 'cancelled', 2, '2026-07-19T10:00:00.000Z'),
    ]);

    const result = await queryArchiveContracts({ fs: fsRoot() });

    const keys = result.entries.map(e => `${e.clawId}:${e.state}:${e.contractId}`);
    expect(keys).toEqual(['a:cancelled:x', 'a:completed:y', 'b:corrupted:z']);
  });

  it('records claw_list_failed issue when claws directory cannot be listed', async () => {
    const err = new Error('EACCES');
    const failingFs = {
      __brand: 'FileSystem',
      exists: async () => true,
      list: async () => { throw err; },
    } as unknown as FileSystem;

    const result = await queryArchiveContracts({ fs: failingFs });

    expect(result.entries).toHaveLength(0);
    expect(result.incomplete).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('claw_list_failed');
    expect(result.issues[0].cause).toBe(err);
  });

  it('continues other claws when one archive list fails', async () => {
    await makeClaw('good');
    await makeClaw('bad');
    await writeCurrentArchive('good', 'completed', 'ok');
    await writeAudit('good', [terminalRow('ok', 'completed', 1, '2026-07-19T10:00:00.000Z')]);

    const err = new Error('EACCES');
    await fs.mkdir(path.join(clawDir('bad'), 'contract', 'archive'), { recursive: true });
    const baseFs = fsRoot();
    const partialFs = new Proxy(baseFs, {
      get(target, prop, receiver) {
        if (prop === 'list') {
          return async (listPath: string, opts?: { includeDirs?: boolean }) => {
            if (listPath === 'claws/bad/contract/archive') {
              throw err;
            }
            return target.list(listPath, opts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as FileSystem;

    const result = await queryArchiveContracts({ fs: partialFs });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].contractId).toBe('ok');
    expect(result.incomplete).toBe(true);
    expect(result.issues.some(i => i.code === 'archive_list_failed' && i.clawId === 'bad')).toBe(true);
  });

  it('returns no entries for an empty claws directory', async () => {
    await fs.mkdir(path.join(chestnutDir, 'claws'), { recursive: true });
    const result = await queryArchiveContracts({ fs: fsRoot() });

    expect(result.entries).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
    expect(result.incomplete).toBe(false);
  });

  it('does not read payload or progress.json', async () => {
    await makeClaw('c1');
    const dir = path.join(archiveDir('c1', 'completed'), 'ct-1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify({ completed_at: '2024-01-01T00:00:00Z' }), 'utf-8');
    await writeAudit('c1', [terminalRow('ct-1', 'completed', 1, '2026-07-19T10:00:00.000Z')]);

    const result = await queryArchiveContracts({ fs: fsRoot() });

    expect(result.entries).toHaveLength(1);
    if (result.entries[0].archiveTime.kind !== 'known') return;
    expect(result.entries[0].archiveTime.recordedAt).toBe('2026-07-19T10:00:00.000Z');
  });
});
