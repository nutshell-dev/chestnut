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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-boot-reconcile-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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
      audit: { write: auditWrite , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
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

  it('retries move for cancelled contract stuck in active/ (phase 954)', async () => {
    const activeDir = path.join(clawDir, 'contract', 'active', 'cancelled-contract');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(
      path.join(activeDir, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        contract_id: 'cancelled-contract',
        status: 'cancelled',
        subtasks: { t1: { status: 'todo' } },
        started_at: new Date().toISOString(),
        checkpoint: null,
      }),
    );
    await fs.writeFile(
      path.join(activeDir, 'contract.yaml'),
      'schema_version: 1\nid: cancelled-contract\ntitle: T\ngoal: G\nsubtasks:\n  - id: t1\n    description: D\n',
    );

    const manager = makeManager();
    await manager.init();

    const movedAudit = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_TERMINAL_MOVED,
    );
    expect(movedAudit).toBeDefined();
    expect(movedAudit).toContainEqual('contract_id=cancelled-contract');
    expect(movedAudit).toContainEqual('status=cancelled');

    const archiveDir = path.join(clawDir, 'contract', 'archive', 'cancelled-contract');
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(activeDir).then(() => true).catch(() => false)).toBe(false);
  });

  it('moves paused contract from active/ to paused/ (phase 954)', async () => {
    const activeDir = path.join(clawDir, 'contract', 'active', 'paused-contract');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(
      path.join(activeDir, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        contract_id: 'paused-contract',
        status: 'paused',
        subtasks: { t1: { status: 'todo' } },
        started_at: new Date().toISOString(),
        checkpoint: null,
      }),
    );

    const manager = makeManager();
    await manager.init();

    const movedAudit = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_PAUSED_MOVED,
    );
    expect(movedAudit).toBeDefined();
    expect(movedAudit).toContainEqual('contract_id=paused-contract');

    const pausedDir = path.join(clawDir, 'contract', 'paused', 'paused-contract');
    expect(await fs.stat(pausedDir).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(activeDir).then(() => true).catch(() => false)).toBe(false);
  });

  it('moves running contract from paused/ to active/ (phase 954)', async () => {
    const pausedDir = path.join(clawDir, 'contract', 'paused', 'running-contract');
    await fs.mkdir(pausedDir, { recursive: true });
    await fs.writeFile(
      path.join(pausedDir, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        contract_id: 'running-contract',
        status: 'running',
        subtasks: { t1: { status: 'todo' } },
        started_at: new Date().toISOString(),
        checkpoint: null,
      }),
    );
    await fs.writeFile(
      path.join(pausedDir, 'contract.yaml'),
      'schema_version: 1\nid: running-contract\ntitle: T\ngoal: G\nsubtasks:\n  - id: t1\n    description: D\n',
    );

    const manager = makeManager();
    await manager.init();

    const movedAudit = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_RUNNING_MOVED,
    );
    expect(movedAudit).toBeDefined();
    expect(movedAudit).toContainEqual('contract_id=running-contract');

    const activeDir = path.join(clawDir, 'contract', 'active', 'running-contract');
    expect(await fs.stat(activeDir).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(pausedDir).then(() => true).catch(() => false)).toBe(false);
  });
});
