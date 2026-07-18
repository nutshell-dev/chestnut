/**
 * Merged test file (test reorganization; no assertion logic changes).
 * Sources:
 *   - boot-reconcile.test.ts
 *   - boot-migrate-archive-skipped-audit.test.ts
 *   - audit-completed-single-emit.test.ts
 *
 * Note: audit-completed-single-emit.test.ts imported `{ promises as fs } from 'fs'`
 * while the other sources imported `* as fs from 'fs/promises'`; the former is
 * aliased to `fsAuditCompleted` here (references updated accordingly).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fsAuditCompleted } from 'fs';
import * as fs from 'fs/promises';
import * as nodeFs from 'node:fs';
import * as os from 'os';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';



/**
 * @module tests/core/contract/boot-reconcile
 * Phase 1335 sub-1: ContractSystem.init() boot reconcile reverse test
 */
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
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  }

  it('emits CONTRACT_BOOT_RECONCILE recovered=false when no active contract needs recovery', async () => {
    const manager = makeManager();
    await manager.init();

    const reconcileCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall).toContainEqual('recovered=false');
  });

  it('leaves legacy paused/ directory untouched and observes it via findLegacyPausedContracts (phase 1123 Step C)', async () => {
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

    // Legacy paused data must not be moved, resumed, or cancelled by boot reconcile.
    expect(await fs.stat(pausedDir).then(() => true).catch(() => false)).toBe(true);

    // Read-only detector surfaces the legacy entry.
    const legacy = await manager.findLegacyPausedContracts();
    expect(legacy).toHaveLength(1);
    expect(legacy[0].contractId).toBe('paused-contract');

    // No recovery-style paused move audits are emitted.
    expect(auditWrite.mock.calls.some((c: any) => c[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_PAUSED_MOVED)).toBe(false);
    expect(auditWrite.mock.calls.some((c: any) => c[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_RUNNING_MOVED)).toBe(false);
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
});

/**
 * @module tests/core/contract/boot-migrate-archive-skipped-audit
 * Phase 1405 Fix 3: boot migration yaml load 失败时显式 audit emit、不静默
 *
 * 否则：progress.json 已写 status='completed' 但 archive 跳过 → 契约 stuck-in-active 永久 +
 * 0 forensics 排查不出原因。
 */
describe('phase 1405 Fix 3: boot migration archive skipped audit', () => {
  let tmpDir: string;
  let clawDir: string;
  let nfs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-boot-migrate-skipped-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeManager(audit: any) {
    return new ContractSystem({
      clawDir, clawId: 'test-claw', fs: nfs, audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),});
  }

  async function seedActiveContractWithEscalatedSubtaskAndMissingYaml(contractId: string) {
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(activeDir, { recursive: true });
    // progress.json 含 'escalated' 子项（phase 1399 前残留）+ 无 yaml
    const progress = {
      schema_version: 1,
      contract_id: contractId,
      status: 'running',
      subtasks: {
        t1: { status: 'escalated', escalated_at: new Date().toISOString() },
      },
    };
    await fs.writeFile(path.join(activeDir, 'progress.json'), JSON.stringify(progress));
    // 故意不写 contract.yaml → loadContractYaml 失败
  }

  it('yaml load 失败 → 显式 emit CONTRACT_BOOT_MIGRATE_ARCHIVE_SKIPPED + 不 throw', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'c-skip-yaml';
    await seedActiveContractWithEscalatedSubtaskAndMissingYaml(contractId);

    // boot reconcile（init）应：migrate escalated → completed + force_accepted、然后尝试 archive 但 yaml load 失败 → audit emit
    await manager.init();

    // CONTRACT_BOOT_MIGRATE_ESCALATED 必发（migrate 路径走通）
    const migrateEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_MIGRATE_ESCALATED);
    expect(migrateEvents.length).toBeGreaterThanOrEqual(1);

    // CONTRACT_BOOT_MIGRATE_ARCHIVE_SKIPPED 必发（archive 跳过留 forensics）
    const skippedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_MIGRATE_ARCHIVE_SKIPPED);
    expect(skippedEvents.length).toBe(1);
    const cols = skippedEvents[0];
    expect(cols.some((c: any) => String(c).includes(`contractId=${contractId}`))).toBe(true);
    expect(cols.some((c: any) => String(c).includes('reason=yaml_load_failed'))).toBe(true);
    expect(cols.some((c: any) => String(c).includes('error='))).toBe(true);
  });

  it('reverse: const land in audit-events.ts + snapshot.json baseline', async () => {
    // phase 263: use static CONTRACT_AUDIT_EVENTS import at top
    expect(CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_MIGRATE_ARCHIVE_SKIPPED).toBe('contract_boot_migrate_archive_skipped');

    const snapshotPath = path.join(__dirname, '../../../src/foundation/audit/audit-events.snapshot.json');
    const snapshot = JSON.parse(nodeFs.readFileSync(snapshotPath, 'utf8')) as { modules: Record<string, string[]> };
    const all = Object.values(snapshot.modules).flat();
    expect(all).toContain('contract_boot_migrate_archive_skipped');
  });
});

/**
 * CONTRACT_AUDIT_EVENTS.COMPLETED single emit (phase 791 / P0.17)
 */
describe('CONTRACT_AUDIT_EVENTS.COMPLETED single emit (phase 791 / P0.17)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let auditCalls: Array<{ type: string; args: string[] }>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fsAuditCompleted.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditCalls = [];
    const captureAudit = {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
      },
    };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('emits COMPLETED exactly once per contract completion (was 2x before fix)', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Single Emit Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    const completedEvents = auditCalls.filter(
      c => c.type === CONTRACT_AUDIT_EVENTS.COMPLETED
    );
    expect(completedEvents).toHaveLength(1);
  });
});
