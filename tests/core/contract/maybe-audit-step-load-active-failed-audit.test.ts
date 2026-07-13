/**
 * @module tests/core/contract/maybe-audit-step-load-active-failed-audit
 * Phase 160: maybeAuditStep loadActive silent catch audit emit (playbook §1)
 *
 * 反向 3 项：
 * 1. loadActive throws → emit AUDITOR_LOAD_ACTIVE_FAILED + 不抛
 * 2. loadActive returns null → 0 AUDITOR_LOAD_ACTIVE_FAILED audit
 * 3. loadActive returns contract → 正常路径 0 改
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

describe('maybeAuditStep loadActive silent catch audit emit (phase 160)', () => {
  let testDir: string;
  let clawDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-maybe-audit-step-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.restoreAllMocks();
  });

  function makeManager() {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: { write: auditWrite, __brand: 'AuditLog' , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });
  }

  // 反向 1：loadActive throws → emit AUDITOR_LOAD_ACTIVE_FAILED + 不抛
  it('反向 1: loadActive throws → emit AUDITOR_LOAD_ACTIVE_FAILED + 不抛', async () => {
    const manager = makeManager();
    const mockAuditor = { maybeAudit: vi.fn().mockResolvedValue({ audited: true }) };
    manager.attachAuditor(mockAuditor as any);

    vi.spyOn(manager, 'loadActive').mockRejectedValue(new Error('EIO'));

    // act: 调 maybeAuditStep、应 resolve 不抛
    await expect(manager.maybeAuditStep(10)).resolves.toBeUndefined();

    // expect: emit AUDITOR_LOAD_ACTIVE_FAILED
    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.AUDITOR_LOAD_ACTIVE_FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall).toContainEqual('clawId=test-claw');
    expect(failedCall).toContainEqual('step=10');
    expect(failedCall).toContainEqual(expect.stringContaining('error='));

    // expect: auditor.maybeAudit 未调（因 catch 提前 return）
    expect(mockAuditor.maybeAudit).not.toHaveBeenCalled();
  });

  // 反向 2：loadActive returns null → 0 AUDITOR_LOAD_ACTIVE_FAILED audit
  it('反向 2: loadActive returns null → 0 AUDITOR_LOAD_ACTIVE_FAILED audit', async () => {
    const manager = makeManager();
    const mockAuditor = { maybeAudit: vi.fn().mockResolvedValue({ audited: true }) };
    manager.attachAuditor(mockAuditor as any);

    vi.spyOn(manager, 'loadActive').mockResolvedValue(null);

    await manager.maybeAuditStep(10);

    // expect: 不 emit AUDITOR_LOAD_ACTIVE_FAILED（既有 silent return path 不退化）
    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.AUDITOR_LOAD_ACTIVE_FAILED,
    );
    expect(failedCall).toBeUndefined();

    // expect: auditor.maybeAudit 未调（因无 active contract）
    expect(mockAuditor.maybeAudit).not.toHaveBeenCalled();
  });

  // 反向 3：loadActive returns contract → 正常路径 0 改
  it('反向 3: loadActive returns contract → 正常路径不动', async () => {
    const manager = makeManager();
    const mockAuditor = { maybeAudit: vi.fn().mockResolvedValue({ audited: true }) };
    manager.attachAuditor(mockAuditor as any);

    vi.spyOn(manager, 'loadActive').mockResolvedValue({
      id: 'c-1',
      title: 'Test Contract',
    } as any);
    vi.spyOn(manager, 'loadContractYaml').mockResolvedValue({
      title: 'Test Contract',
      goal: 'G',
      subtasks: [],
      audit_interval: 1,
      expectations: 'do it',
    } as any);
    vi.spyOn(manager, 'getProgress').mockResolvedValue({
      schema_version: 1,
      contract_id: 'c-1',
      status: 'active',
      subtasks: {},
      started_at: '2024-01-01T00:00:00Z',
    } as any);

    await manager.maybeAuditStep(10);

    // expect: 不 emit AUDITOR_LOAD_ACTIVE_FAILED
    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.AUDITOR_LOAD_ACTIVE_FAILED,
    );
    expect(failedCall).toBeUndefined();

    // expect: auditor.maybeAudit 被调（正常路径）
    expect(mockAuditor.maybeAudit).toHaveBeenCalledTimes(1);
    expect(mockAuditor.maybeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: 'c-1',
        clawId: 'test-claw',
        currentStep: 10,
      }),
    );
  });
});
