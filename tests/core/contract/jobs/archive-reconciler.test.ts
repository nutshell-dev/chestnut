/**
 * Phase 188 Step C: archive-reconciler unit tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { reconcileArchiveStaleEntries } from '../../../../src/core/contract/jobs/archive-reconciler.js';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../../utils/temp.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../../src/core/contract/audit-events.js';

describe('Phase 188 Step C: reconcileArchiveStaleEntries', () => {
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

  async function setupArchiveEntry(contractId: string, status: string) {
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ schema_version: 1,
        contract_id: contractId,
        status,
        subtasks: {},
        checkpoint: null,
      }, null, 2)
    );
  }

  async function readArchiveStatus(contractId: string): Promise<string> {
    const raw = await fs.readFile(path.join(clawDir, 'contract', 'archive', contractId, 'progress.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.status;
  }

  // 3 active 态 → 翻
  it('flips pending → archive_corrupted', async () => {
    await setupArchiveEntry('c-pending', 'pending');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.failed).toBe(0);
    expect(await readArchiveStatus('c-pending')).toBe('archive_corrupted');

    const staleAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_STALE);
    expect(staleAudits).toHaveLength(1);
    expect(staleAudits[0].args.some(a => a.includes('oldStatus=pending'))).toBe(true);
  });

  it('flips running → archive_corrupted', async () => {
    await setupArchiveEntry('c-running', 'running');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.failed).toBe(0);
    expect(await readArchiveStatus('c-running')).toBe('archive_corrupted');
  });

  it('flips paused → archive_corrupted', async () => {
    await setupArchiveEntry('c-paused', 'paused');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.failed).toBe(0);
    expect(await readArchiveStatus('c-paused')).toBe('archive_corrupted');
  });

  // 5 终态 → 跳过
  it('skips completed (no flip)', async () => {
    await setupArchiveEntry('c-completed', 'completed');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(0);
    expect(result.scanned).toBe(1);
    expect(await readArchiveStatus('c-completed')).toBe('completed');
  });

  it('skips cancelled (no flip)', async () => {
    await setupArchiveEntry('c-cancelled', 'cancelled');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(0);
    expect(result.scanned).toBe(1);
    expect(await readArchiveStatus('c-cancelled')).toBe('cancelled');
  });

  it('skips crashed (no flip)', async () => {
    await setupArchiveEntry('c-crashed', 'crashed');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(0);
    expect(result.scanned).toBe(1);
    expect(await readArchiveStatus('c-crashed')).toBe('crashed');
  });

  it('skips archive_pending_recovery (no flip)', async () => {
    await setupArchiveEntry('c-recovery', 'archive_pending_recovery');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(0);
    expect(result.scanned).toBe(1);
    expect(await readArchiveStatus('c-recovery')).toBe('archive_pending_recovery');
  });

  it('skips archive_corrupted (no flip)', async () => {
    await setupArchiveEntry('c-corrupted', 'archive_corrupted');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(0);
    expect(result.scanned).toBe(1);
    expect(await readArchiveStatus('c-corrupted')).toBe('archive_corrupted');
  });

  // 混合场景
  it('mixed: 2 active + 2 terminal → 2 swept + 2 skipped + summary audit', async () => {
    await setupArchiveEntry('c1', 'pending');
    await setupArchiveEntry('c2', 'completed');
    await setupArchiveEntry('c3', 'running');
    await setupArchiveEntry('c4', 'cancelled');
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(2);
    expect(result.scanned).toBe(4);
    expect(result.failed).toBe(0);

    const summaryAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_SUMMARY);
    expect(summaryAudits).toHaveLength(1);
    expect(summaryAudits[0].args.some(a => a.includes('scanned=4'))).toBe(true);
    expect(summaryAudits[0].args.some(a => a.includes('swept=2'))).toBe(true);
  });

  // schema-invalid progress.json
  it('schema-invalid progress.json → failed++ + audit + continue others', async () => {
    await setupArchiveEntry('c-good', 'pending');
    const badDir = path.join(clawDir, 'contract', 'archive', 'c-bad');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'progress.json'), JSON.stringify({ invalid: true }));

    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.failed).toBe(1);

    const failedAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_FAILED);
    expect(failedAudits).toHaveLength(1);
    expect(failedAudits[0].args.some(a => a.includes('contractId=c-bad'))).toBe(true);
    expect(failedAudits[0].args.some(a => a.includes('context=schema_invalid'))).toBe(true);
  });

  // corrupt (non-JSON) progress.json
  it('non-JSON progress.json → failed++ + audit + continue others', async () => {
    await setupArchiveEntry('c-good2', 'pending');
    const badDir = path.join(clawDir, 'contract', 'archive', 'c-bad2');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'progress.json'), 'not-json');

    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.failed).toBe(1);

    const failedAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_FAILED);
    expect(failedAudits).toHaveLength(1);
    expect(failedAudits[0].args.some(a => a.includes('contractId=c-bad2'))).toBe(true);
  });

  // missing progress.json
  it('missing progress.json → failed++ + audit + continue others', async () => {
    await setupArchiveEntry('c-good3', 'pending');
    const badDir = path.join(clawDir, 'contract', 'archive', 'c-missing');
    await fs.mkdir(badDir, { recursive: true });

    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.failed).toBe(1);

    const failedAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_FAILED);
    expect(failedAudits).toHaveLength(1);
    expect(failedAudits[0].args.some(a => a.includes('contractId=c-missing'))).toBe(true);
    expect(failedAudits[0].args.some(a => a.includes('context=progress_missing'))).toBe(true);
  });

  // missing archive dir → 0 sweep
  it('missing archive dir → 0 sweep no throw', async () => {
    const result = await reconcileArchiveStaleEntries(
      { fs: nodeFs, audit: makeAudit() as any },
      'test-claw',
      clawDir,
    );
    expect(result.swept).toBe(0);
    expect(result.scanned).toBe(0);
    expect(result.failed).toBe(0);
  });
});
