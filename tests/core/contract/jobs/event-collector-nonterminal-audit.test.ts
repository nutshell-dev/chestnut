/**
 * Phase 188 Step B: event-collector non-terminal audit
 */
import { describe, it, expect } from 'vitest';
import { scanArchivedContracts } from '../../../../src/core/contract/jobs/event-collector.js';
import type { FileSystem } from '../../../../src/foundation/fs/types.js';
import { makeAudit } from '../../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../../src/core/contract/audit-events.js';

function makeFsForStatus(status: string, checkpoint?: string): FileSystem {
  const files = new Map<string, string>();
  files.set('/tmp/claw/contract/archive/c1/progress.json', JSON.stringify({ schema_version: 1,
    contract_id: 'c1',
    status,
    checkpoint: checkpoint ?? null,
    subtasks: {},
  }));

  const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();
  dirs.set('/tmp/claw/contract/archive', [{ name: 'c1', isDirectory: true, size: 0 }]);

  return {
    listSync: (p: string) => dirs.get(p) ?? [],
    readSync: (p: string) => {
      if (files.has(p)) return files.get(p)!;
      throw new Error('ENOENT');
    },
    existsSync: () => true,
  } as unknown as FileSystem;
}

function makeFsForMixed(statuses: string[]): FileSystem {
  const files = new Map<string, string>();
  const dirEntries: { name: string; isDirectory: boolean; size: number }[] = [];
  for (let i = 0; i < statuses.length; i++) {
    const name = `c${i}`;
    dirEntries.push({ name, isDirectory: true, size: 0 });
    files.set(`/tmp/claw/contract/archive/${name}/progress.json`, JSON.stringify({ schema_version: 1,
      contract_id: name,
      status: statuses[i],
      checkpoint: null,
      subtasks: {},
    }));
  }

  const dirs = new Map<string, typeof dirEntries>();
  dirs.set('/tmp/claw/contract/archive', dirEntries);

  return {
    listSync: (p: string) => dirs.get(p) ?? [],
    readSync: (p: string) => {
      if (files.has(p)) return files.get(p)!;
      throw new Error('ENOENT');
    },
    existsSync: () => true,
  } as unknown as FileSystem;
}

describe('phase 188 Step B: non-terminal archive entries emit audit, skip inbox', () => {
  it('pending → null + CONTRACT_ARCHIVE_NONTERMINAL_DETECTED audit', () => {
    const { audit, events } = makeAudit();
    const fs = makeFsForStatus('pending');
    const entries = scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(0);
    const auditEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_NONTERMINAL_DETECTED);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].some(c => c.includes('status=pending'))).toBe(true);
  });

  it('running → null + CONTRACT_ARCHIVE_NONTERMINAL_DETECTED audit', () => {
    const { audit, events } = makeAudit();
    const fs = makeFsForStatus('running');
    const entries = scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(0);
    const auditEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_NONTERMINAL_DETECTED);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].some(c => c.includes('status=running'))).toBe(true);
  });

  it('paused → null + CONTRACT_ARCHIVE_NONTERMINAL_DETECTED audit', () => {
    const { audit, events } = makeAudit();
    const fs = makeFsForStatus('paused');
    const entries = scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(0);
    const auditEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_NONTERMINAL_DETECTED);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].some(c => c.includes('status=paused'))).toBe(true);
  });

  it('mixed: 2 terminal + 2 active → 2 entries + 2 audit emits', () => {
    const { audit, events } = makeAudit();
    const fs = makeFsForMixed(['completed', 'pending', 'crashed', 'running']);
    const entries = scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe('completed');
    expect(entries[1].status).toBe('crashed');

    const auditEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_NONTERMINAL_DETECTED);
    expect(auditEvents).toHaveLength(2);
  });

  it('all terminal → 4 entries + 0 audit', () => {
    const { audit, events } = makeAudit();
    const fs = makeFsForMixed(['completed', 'cancelled', 'crashed', 'archive_pending_recovery']);
    const entries = scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(4);
    const auditEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_NONTERMINAL_DETECTED);
    expect(auditEvents).toHaveLength(0);
  });
});
