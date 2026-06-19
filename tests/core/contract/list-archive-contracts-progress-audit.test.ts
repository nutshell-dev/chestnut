/**
 * @module tests/core/contract/list-archive-contracts-progress-audit
 * Phase 164: listArchiveContracts progress.json non-ENOENT silent catch audit emit (playbook §1)
 *
 * 反向 4 项：
 * 1. progress.json ENOENT → 0 audit + 继续列举（archivedAt undefined）
 * 2. progress.json JSON.parse fail → emit ARCHIVE_PROGRESS_READ_FAILED + 继续列举
 * 3. fs.readSync EACCES → emit ARCHIVE_PROGRESS_READ_FAILED + 继续列举
 * 4. progress.json 正常 → 0 audit + archivedAt 正确解析
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { listArchiveContracts } from '../../../src/core/contract/persistence.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

describe('listArchiveContracts progress.json audit (phase 164)', () => {
  let testDir: string;
  let chestnutDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-list-archive-audit-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    chestnutDir = path.join(testDir, 'chestnut');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(chestnutDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.restoreAllMocks();
  });

  function makeAudit() {
    return { write: auditWrite, __brand: 'AuditLog' } as any;
  }

  // 反向 1：progress.json ENOENT → 0 audit + 继续列举（archivedAt undefined）
  it('反向 1: progress.json ENOENT → 0 audit + 继续列举', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    // intentionally NO progress.json

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({ fs: nodeFs, audit: makeAudit() });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].archivedAt).toBeUndefined();

    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
    );
    expect(failedCall).toBeUndefined();
  });

  // 反向 2：progress.json JSON.parse fail → emit ARCHIVE_PROGRESS_READ_FAILED + 继续列举
  it('反向 2: progress.json JSON.parse fail → emit ARCHIVE_PROGRESS_READ_FAILED', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'progress.json'), '{invalid json');

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({ fs: nodeFs, audit: makeAudit() });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].archivedAt).toBeUndefined();

    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall).toContainEqual('clawId=c1');
    expect(failedCall).toContainEqual('contractId=ct-1');
    expect(failedCall).toContainEqual(expect.stringContaining('error='));
  });

  // 反向 3：fs.readSync EACCES → emit ARCHIVE_PROGRESS_READ_FAILED + 继续列举
  it('反向 3: fs.readSync EACCES → emit ARCHIVE_PROGRESS_READ_FAILED', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'progress.json'), '{}');

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    vi.spyOn(nodeFs, 'readSync').mockImplementation((p: string) => {
      if (p.includes('progress.json')) throw eaccesError;
      // fallback for any other readSync (should not happen here)
      return fs.readFileSync(path.join(chestnutDir, p), 'utf-8');
    });

    const result = await listArchiveContracts({ fs: nodeFs, audit: makeAudit() });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].archivedAt).toBeUndefined();

    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall).toContainEqual('clawId=c1');
    expect(failedCall).toContainEqual('contractId=ct-1');
    expect(failedCall).toContainEqual(expect.stringContaining('error='));
  });

  // 反向 4：progress.json 正常 → 0 audit + archivedAt 正确解析
  it('反向 4: progress.json 正常 → 0 audit + archivedAt 正确解析', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ completed_at: '2024-01-15T00:00:00Z' }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({ fs: nodeFs, audit: makeAudit() });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].archivedAt).toBe('2024-01-15T00:00:00Z');

    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
    );
    expect(failedCall).toBeUndefined();
  });
});
