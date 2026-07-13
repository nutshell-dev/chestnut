/**
 * @module tests/core/contract/boot-migrate-archive-skipped-audit
 * Phase 1405 Fix 3: boot migration yaml load 失败时显式 audit emit、不静默
 *
 * 否则：progress.json 已写 status='completed' 但 archive 跳过 → 契约 stuck-in-active 永久 +
 * 0 forensics 排查不出原因。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as nodeFs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

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
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

describe('phase 1405 Fix 3: boot migration archive skipped audit', () => {
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
