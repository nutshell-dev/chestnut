/**
 * @module tests/core/contract/verification-escalated-state-valid
 * Phase 1399: force-accept state transition valid (phase 1399)
 * Verifies that max verification attempts triggers force-accept with valid transition + recovery path.
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
    `.test-escalated-valid-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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

describe('force-accept state transition valid (phase 1399)', () => {
  it('max attempts reached → subtask.status completed + force_accepted + audit emit + recovery path executable', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
      verification_attempts: 2,
    }));

    // Mock script verification to always fail
    vi.spyOn(manager as any, 'runScriptVerification').mockResolvedValue({ passed: false, feedback: 'bad' });

    // First failure (wait for background done before next call to avoid mutex race)
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
    await new Promise(r => setTimeout(r, 100));

    // Second failure → force-accept (retry_count reaches verification_attempts=2)
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e2' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
    await new Promise(r => setTimeout(r, 100));

    // Verify force-accepted audit
    const forceAcceptedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED);
    expect(forceAcceptedEvents.length).toBeGreaterThanOrEqual(1);
    const lastForceAccepted = forceAcceptedEvents[forceAcceptedEvents.length - 1];
    expect(lastForceAccepted.some((c: any) => String(c).includes('contractId=' + contractId))).toBe(true);
    expect(lastForceAccepted.some((c: any) => String(c).includes('subtaskId=t1'))).toBe(true);

    // Verify progress shows completed + force_accepted status
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['t1'].status).toBe('completed');
    expect(progress.subtasks['t1'].force_accepted).toBe(true);

    // Recovery path: contract is auto-completed after force-accept (archive via archiveAndEmit)
    const progressAfter = await manager.getProgress(contractId);
    expect(progressAfter.status).toBe('completed');
  });
});
