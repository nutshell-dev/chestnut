/**
 * @module tests/core/contract/verification-outcome-observability
 * Phase 1371 sub-4: outcome==null observability reverse test
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
    `.test-outcome-observability-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

function makeManager(audit: any) {
  return new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
}

describe('verification outcome observability (phase 1371 sub-4)', () => {
  it('cancelled contract → background done audit contains outcomeKind=cancelled + cancel_reason', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
    }));

    // Cancel the contract
    await manager.cancel(contractId, 'test cancel');

    // Mock runScriptVerification so it would succeed if not cancelled
    vi.spyOn(manager as any, 'runScriptVerification').mockResolvedValue({ passed: true, feedback: 'ok' });

    // Start pipeline — it should read cancelled status and abort
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });

    // Wait for background done audit
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const doneEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    const lastDone = doneEvents[doneEvents.length - 1];
    expect(lastDone.some((c: any) => String(c).includes('result=cancelled'))).toBe(true);
    expect(lastDone.some((c: any) => String(c).includes('cancel_reason='))).toBe(true);
  });

  it('missing subtask → background done audit contains outcomeKind=missing_subtask + missing_subtask_id', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
    }));

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');

    // Mock runScriptVerification to delay, then delete subtask mid-flight
    vi.spyOn(manager as any, 'runScriptVerification').mockImplementation(async () => {
      // Delete subtask while background verification is running
      const raw = await fs.readFile(progressPath, 'utf-8');
      const progress = JSON.parse(raw);
      delete progress.subtasks['t1'];
      await fs.writeFile(progressPath, JSON.stringify(progress));
      return { passed: true, feedback: 'ok' };
    });

    // Start pipeline
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });

    // Wait for background done audit
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const doneEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    const lastDone = doneEvents[doneEvents.length - 1];
    expect(lastDone.some((c: any) => String(c).includes('result=missing_subtask'))).toBe(true);
    expect(lastDone.some((c: any) => String(c).includes('missing_subtask_id=t1'))).toBe(true);
  });
});
