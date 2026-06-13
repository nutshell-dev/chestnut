/**
 * Phase 188 Step C: archive-reconciler init integration test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ContractSystem } from '../../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../../utils/temp.js';
import { makeContractYaml } from '../../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../../src/core/contract/audit-events.js';

describe('Phase 188 Step C: init integration — archive sweep on boot', () => {
  let tempDir: string;
  let clawDir: string;
  let auditCalls: Array<{ type: string; args: string[] }>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    auditCalls = [];
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeManager() {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const captureAudit = {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
      },
    };
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: () => {},
    });
  }

  async function setupArchiveEntry(contractId: string, status: string) {
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ schema_version: 1,
        contract_id: contractId,
        status,
        subtasks: {},
        checkpoint: null,
      }, null, 2)
    );
  }

  async function readArchiveStatus(contractId: string): Promise<string> {
    const raw = await fs.readFile(path.join(clawDir, 'contract', 'archive', contractId, 'progress.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.status;
  }

  it('init sweeps archive: active entries flipped to archive_pending_recovery', async () => {
    await setupArchiveEntry('c-running', 'running');
    await setupArchiveEntry('c-pending', 'pending');
    await setupArchiveEntry('c-completed', 'completed');

    const manager = makeManager();
    await manager.init();

    expect(await readArchiveStatus('c-running')).toBe('archive_pending_recovery');
    expect(await readArchiveStatus('c-pending')).toBe('archive_pending_recovery');
    expect(await readArchiveStatus('c-completed')).toBe('completed');

    const staleAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_STALE);
    expect(staleAudits).toHaveLength(2);

    const summaryAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_SUMMARY);
    expect(summaryAudits).toHaveLength(1);
    expect(summaryAudits[0].args.some(a => a.includes('swept=2'))).toBe(true);
  });

  it('second init does not re-flip already reconciled entries', async () => {
    await setupArchiveEntry('c-running', 'running');

    const manager1 = makeManager();
    await manager1.init();
    expect(await readArchiveStatus('c-running')).toBe('archive_pending_recovery');

    // reset audit for second init
    auditCalls = [];
    const manager2 = makeManager();
    await manager2.init();

    // already archive_pending_recovery, should not be swept again
    const staleAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_STALE);
    expect(staleAudits).toHaveLength(0);

    const summaryAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_SUMMARY);
    expect(summaryAudits).toHaveLength(1);
    expect(summaryAudits[0].args.some(a => a.includes('swept=0'))).toBe(true);
  });
});
