/**
 * @module tests/core/contract/verification-archive-partial-recovery
 * Phase 1371 sub-2: archiveAndEmit partial recovery reverse test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-archive-partial-recovery-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function makeManager(audit: any) {
  return new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
  });
}

describe('archiveAndEmit partial recovery (phase 1371 sub-2)', () => {
  it('archive fails + rollback fails → progress.status set to archive_pending_recovery + audit emit', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    // Create a contract that will be forced into archive failure
    const contractId = await manager.create(makeContractYaml({ subtasks: [{ id: 't1', description: 'd1' }] }));

    // Spy moveToArchive to throw (simulating archive failure)
    const moveSpy = vi.spyOn(manager as any, 'moveToArchive').mockRejectedValue(new Error('disk full'));

    // Mock saveProgress to throw on rollback (rollback failure)
    // We intercept the second withProgressLock call (the revert) by mocking saveProgress
    let saveProgressCallCount = 0;
    const originalSaveProgress = (manager as any).saveProgress.bind(manager);
    vi.spyOn(manager as any, 'saveProgress').mockImplementation(async (id: string, progress: any) => {
      if (id === contractId && progress.status === 'running') {
        saveProgressCallCount++;
        if (saveProgressCallCount === 1) {
          throw new Error('rollback save failed');
        }
      }
      return originalSaveProgress(id, progress);
    });

    // Manually set contract to completed so archiveAndEmit tries to archive
    await (manager as any).withProgressLock(contractId, async () => {
      const progress = await manager.getProgress(contractId);
      progress.status = 'completed';
      progress.subtasks['t1'].status = 'completed';
      progress.subtasks['t1'].completed_at = new Date().toISOString();
      await (manager as any).saveProgress(contractId, progress);
    });

    // Call archiveAndEmit indirectly via the private _verificationCtx -> archiveAndEmit
    const { archiveAndEmit } = await import('../../../src/core/contract/verification-lifecycle.js');
    await archiveAndEmit(
      (manager as any)._verificationCtx(),
      contractId,
      'test-title',
      'test-context',
    );

    // Verify audit emit for partial recovery
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.ARCHIVE_PARTIAL_RECOVERY_FAILED);
    const partialRecoveryEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PARTIAL_RECOVERY_FAILED);
    expect(partialRecoveryEvents.length).toBeGreaterThanOrEqual(1);

    // Verify progress.status is archive_pending_recovery
    const progressAfter = await manager.getProgress(contractId);
    expect(progressAfter.status).toBe('archive_pending_recovery');

    moveSpy.mockRestore();
  });

  it('boot reconcile recovers archive_pending_recovery contracts', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);

    // Create a contract and manually set status to archive_pending_recovery
    const contractId = await manager.create(makeContractYaml({ subtasks: [{ id: 't1', description: 'd1' }] }));
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    const raw = await fs.readFile(progressPath, 'utf-8');
    const progress = JSON.parse(raw);
    progress.status = 'archive_pending_recovery';
    await fs.writeFile(progressPath, JSON.stringify(progress));

    // init() should detect archive_pending_recovery and attempt recovery
    await manager.init();

    // After init, contract should be archived (moved to archive dir)
    const archiveProgressPath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.json');
    const archiveExists = await fs.access(archiveProgressPath).then(() => true).catch(() => false);
    expect(archiveExists).toBe(true);

    // Verify CONTRACT_COMPLETED audit was emitted
    const completedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.COMPLETED);
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
  });
});
