/**
 * Phase 1127 Step E: archive legacy migrator unit tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { migrateLegacyArchiveEntries } from '../../../../src/core/contract/jobs/archive-legacy-migrator.js';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../../utils/temp.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../../src/core/contract/audit-events.js';

describe('Phase 1127 Step E: migrateLegacyArchiveEntries', () => {
  let tempDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;
  let auditCalls: Array<{ type: string; args: string[] }>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditCalls = [];
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeAudit() {
    return {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
      },
    };
  }

  async function setupLegacyEntry(contractId: string, status: string | null) {
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(archiveDir, { recursive: true });
    const payload: Record<string, unknown> = {
      schema_version: 1,
      contract_id: contractId,
      subtasks: {},
      checkpoint: null,
    };
    if (status !== null) {
      payload.status = status;
    }
    await fs.writeFile(path.join(archiveDir, 'progress.json'), JSON.stringify(payload, null, 2));
  }

  async function entryExists(relativePath: string): Promise<boolean> {
    return fs.access(path.join(clawDir, relativePath)).then(() => true).catch(() => false);
  }

  it('migrates completed → archive/completed', async () => {
    await setupLegacyEntry('c-completed', 'completed');
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: 1, migrated: 1, conflicts: 0, skipped: 0, failed: 0 });
    expect(await entryExists('contract/archive/c-completed')).toBe(false);
    expect(await entryExists('contract/archive/completed/c-completed/progress.json')).toBe(true);

    const migratedAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATED);
    expect(migratedAudits).toHaveLength(1);
    expect(migratedAudits[0].args.some(a => a.includes('evidence=completed'))).toBe(true);
  });

  it('migrates cancelled → archive/cancelled', async () => {
    await setupLegacyEntry('c-cancelled', 'cancelled');
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: 1, migrated: 1, conflicts: 0, skipped: 0, failed: 0 });
    expect(await entryExists('contract/archive/c-cancelled')).toBe(false);
    expect(await entryExists('contract/archive/cancelled/c-cancelled/progress.json')).toBe(true);
  });

  it('migrates archive_corrupted → archive/corrupted', async () => {
    await setupLegacyEntry('c-corrupted', 'archive_corrupted');
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: 1, migrated: 1, conflicts: 0, skipped: 0, failed: 0 });
    expect(await entryExists('contract/archive/c-corrupted')).toBe(false);
    expect(await entryExists('contract/archive/corrupted/c-corrupted/progress.json')).toBe(true);
  });

  it('is idempotent: second run is no-op', async () => {
    await setupLegacyEntry('c-completed', 'completed');
    const audit1 = makeAudit();
    await migrateLegacyArchiveEntries({ fs: nodeFs, audit: audit1 as any }, 'test-claw', clawDir);

    auditCalls = [];
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: 0, migrated: 0, conflicts: 0, skipped: 0, failed: 0 });
    expect(auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATED)).toHaveLength(0);
  });

  it('skips crashed (never maps to corrupted)', async () => {
    await setupLegacyEntry('c-crashed', 'crashed');
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: 1, migrated: 0, conflicts: 0, skipped: 1, failed: 0 });
    expect(await entryExists('contract/archive/c-crashed/progress.json')).toBe(true);
    expect(await entryExists('contract/archive/corrupted/c-crashed')).toBe(false);

    const skippedAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATION_SKIPPED);
    expect(skippedAudits[0].args.some(a => a.includes('unmigrable_status=crashed'))).toBe(true);
  });

  it('skips paused / active / pending / running / archive_pending_recovery', async () => {
    const statuses = ['paused', 'active', 'pending', 'running', 'archive_pending_recovery'];
    for (let i = 0; i < statuses.length; i++) {
      await setupLegacyEntry(`c-${i}`, statuses[i]);
    }
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: statuses.length, migrated: 0, conflicts: 0, skipped: statuses.length, failed: 0 });
    for (let i = 0; i < statuses.length; i++) {
      expect(await entryExists(`contract/archive/c-${i}/progress.json`)).toBe(true);
    }
  });

  it('skips missing progress.json', async () => {
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'c-no-progress');
    await fs.mkdir(archiveDir, { recursive: true });
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: 1, migrated: 0, conflicts: 0, skipped: 1, failed: 0 });
  });

  it('skips invalid progress.json schema', async () => {
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'c-bad-schema');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'progress.json'), '{invalid');
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: 1, migrated: 0, conflicts: 0, skipped: 1, failed: 0 });
  });

  it('records conflict and preserves both sides when target exists', async () => {
    await setupLegacyEntry('c-conflict', 'completed');
    const targetDir = path.join(clawDir, 'contract', 'archive', 'completed', 'c-conflict');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      path.join(targetDir, 'progress.json'),
      JSON.stringify({ schema_version: 1, contract_id: 'c-conflict', status: 'completed', subtasks: {} }),
    );

    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result).toMatchObject({ scanned: 1, migrated: 0, conflicts: 1, skipped: 0, failed: 0 });
    expect(await entryExists('contract/archive/c-conflict/progress.json')).toBe(true);
    expect(await entryExists('contract/archive/completed/c-conflict/progress.json')).toBe(true);

    const conflictAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATION_CONFLICT);
    expect(conflictAudits).toHaveLength(1);
  });

  it('emits summary event', async () => {
    await setupLegacyEntry('c-completed', 'completed');
    await setupLegacyEntry('c-crashed', 'crashed');
    const result = await migrateLegacyArchiveEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    const summaryAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATION_SUMMARY);
    expect(summaryAudits).toHaveLength(1);
    expect(summaryAudits[0].args.some(a => a.includes(`scanned=${result.scanned}`))).toBe(true);
    expect(summaryAudits[0].args.some(a => a.includes(`migrated=${result.migrated}`))).toBe(true);
  });
});
