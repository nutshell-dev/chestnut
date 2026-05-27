/**
 * @module tests/core/contract/boot-reconcile
 * Phase 1335 sub-1: ContractSystem.init() boot reconcile reverse test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

describe('ContractSystem.init() boot reconcile', () => {
  let testDir: string;
  let clawDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-boot-reconcile-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  function makeManager() {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: { write: auditWrite } as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    });
  }

  it('emits CONTRACT_BOOT_RECONCILE recovered=true when paused contract exists', async () => {
    const pausedDir = path.join(clawDir, 'contract', 'paused', 'paused-contract');
    await fs.mkdir(pausedDir, { recursive: true });
    await fs.writeFile(
      path.join(pausedDir, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        contract_id: 'paused-contract',
        status: 'paused',
        subtasks: { t1: { status: 'todo' } },
        started_at: new Date().toISOString(),
        checkpoint: null,
      }),
    );
    await fs.writeFile(
      path.join(pausedDir, 'contract.yaml'),
      'schema_version: 1\nid: paused-contract\ntitle: T\ngoal: G\nsubtasks:\n  - id: t1\n    description: D\n',
    );

    const manager = makeManager();
    await manager.init();

    const reconcileCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall).toContainEqual('paused_contract_id=paused-contract');
    expect(reconcileCall).toContainEqual('recovered=true');
  });

  it('emits CONTRACT_BOOT_RECONCILE recovered=false when no paused contract', async () => {
    const manager = makeManager();
    await manager.init();

    const reconcileCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall).toContainEqual('recovered=false');
  });
});
