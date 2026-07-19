/**
 * Phase 63 Step G: event-collector formatContractEvent status 分支测试
 */

import { describe, it, expect } from 'vitest';
import { scanArchivedContracts } from '../../../../src/core/contract/jobs/event-collector.js';
import type { FileSystem } from '../../../../src/foundation/fs/types.js';
import { makeAudit } from '../../../helpers/audit.js';

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

describe('phase 63: formatContractEvent status 分支', () => {
  it('completed → [contract_completed] + status 字段', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('completed');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatch(/^\[contract_completed\]/);
    expect(entries[0].status).toBe('completed');
  });

  it('cancelled → [contract_cancelled] + reason + status 字段', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('cancelled', 'cancelled: user manual');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatch(/^\[contract_cancelled\]/);
    expect(entries[0].body).toContain('reason: user manual');
    expect(entries[0].status).toBe('cancelled');
    expect(entries[0].reason).toBe('user manual');
  });

  it('crashed (legacy) → [contract_crashed] body + cause + status 字段（observer 侧只 audit、不投 motion）', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('crashed', 'crashed: system: maxstepsexceedederror');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatch(/^\[contract_crashed\]/);
    expect(entries[0].body).toContain('cause: system: maxstepsexceedederror');
    expect(entries[0].status).toBe('crashed');
    expect(entries[0].cause).toBe('system: maxstepsexceedederror');
  });

  it('Step F: archive_pending_recovery legacy flat entry is skipped (no event)', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('archive_pending_recovery');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(0);
  });

  it('Step F: archive_corrupted legacy flat entry maps to corrupted archive state', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('archive_corrupted');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatch(/^\[contract_archive_corrupted\]/);
    expect(entries[0].status).toBe('corrupted');
    expect(entries[0].hasFailure).toBe(true);
  });
});
