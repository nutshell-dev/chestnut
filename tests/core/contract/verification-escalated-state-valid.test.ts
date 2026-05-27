/**
 * @module tests/core/contract/verification-escalated-state-valid
 * Phase 1371 sub-5: 'escalated' state spec divergence — reverse test
 * Verifies that 'escalated' is a legitimate SubtaskStatus with valid transition + recovery path.
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

describe('escalated state transition valid (phase 1371 sub-5)', () => {
  it('max retries reached → subtask.status escalated + audit emit + recovery path executable', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
      escalation: { max_retries: 2 },
    }));

    // Mock script verification to always fail
    vi.spyOn(manager as any, 'runScriptVerification').mockResolvedValue({ passed: false, feedback: 'bad' });

    // First failure (wait for background done before next call to avoid mutex race)
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
    await new Promise(r => setTimeout(r, 100));

    // Second failure
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e2' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
    await new Promise(r => setTimeout(r, 100));

    // Third failure → escalation
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e3' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.ESCALATED);
    await new Promise(r => setTimeout(r, 100));

    // Verify escalated audit
    const escalatedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ESCALATED);
    expect(escalatedEvents.length).toBeGreaterThanOrEqual(1);
    const lastEscalated = escalatedEvents[escalatedEvents.length - 1];
    expect(lastEscalated.some((c: any) => String(c).includes('contractId=' + contractId))).toBe(true);
    expect(lastEscalated.some((c: any) => String(c).includes('subtaskId=t1'))).toBe(true);

    // Verify progress shows escalated status
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['t1'].status).toBe('escalated');
    expect(typeof progress.subtasks['t1'].escalated_at).toBe('string');

    // Recovery path: contract can still be cancelled after escalation
    await manager.cancel(contractId, 'escalated recovery');
    const progressAfterCancel = await manager.getProgress(contractId);
    expect(progressAfterCancel.status).toBe('cancelled');
  });
});
