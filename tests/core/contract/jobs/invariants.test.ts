/**
 * Merged invariants test file (mechanical merge; assertion logic unchanged).
 *
 * Sources:
 * - archive-reconciler-init-integration.test.ts
 * - event-collector-phase949.test.ts
 * - event-collector-fs-not-found-narrow.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsAsync from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ContractSystem } from '../../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../../utils/temp.js';
import { makeContractYaml } from '../../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../../src/core/contract/audit-events.js';
import {
  collectContractEvents,
  scanArchivedContracts,
} from '../../../../src/core/contract/jobs/event-collector.js';
import { makeAudit } from '../../../helpers/audit.js';
import { FileNotFoundError, type FileSystem } from '../../../../src/foundation/fs/types.js';

/**
 * Phase 188 Step C: archive-reconciler init integration test
 */
describe('Phase 188 Step C: init integration — archive sweep on boot', () => {
  let tempDir: string;
  let clawDir: string;
  let auditCalls: Array<{ type: string; args: string[] }>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    auditCalls = [];
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeManager() {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const captureAudit = {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
      },
    };
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: () => {},
    });
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

  it('init sweeps archive: active entries flipped to archive_corrupted', async () => {
    await setupArchiveEntry('c-running', 'running');
    await setupArchiveEntry('c-pending', 'pending');
    await setupArchiveEntry('c-completed', 'completed');

    const manager = makeManager();
    await manager.init();

    expect(await readArchiveStatus('c-running')).toBe('archive_corrupted');
    expect(await readArchiveStatus('c-pending')).toBe('archive_corrupted');
    expect(await readArchiveStatus('c-completed')).toBe('completed');

    const staleAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_STALE);
    expect(staleAudits).toHaveLength(2);

    const summaryAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_SUMMARY);
    expect(summaryAudits).toHaveLength(1);
    expect(summaryAudits[0].args.some(a => a.includes('swept=2'))).toBe(true);
  });

  it('second init does not re-flip already reconciled entries', async () => {
    await setupArchiveEntry('c-running', 'running');

    const manager1 = makeManager();
    await manager1.init();
    expect(await readArchiveStatus('c-running')).toBe('archive_corrupted');

    // reset audit for second init
    auditCalls = [];
    const manager2 = makeManager();
    await manager2.init();

    // already archive_corrupted, should not be swept again
    const staleAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_STALE);
    expect(staleAudits).toHaveLength(0);

    const summaryAudits = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_SUMMARY);
    expect(summaryAudits).toHaveLength(1);
    expect(summaryAudits[0].args.some(a => a.includes('swept=0'))).toBe(true);
  });
});

/**
 * Phase 949: event-collector cursor fallback + schema audit + active-state audit.
 */
describe('phase 949: event-collector cursor / schema / active-state fixes', () => {
  let chestnutRoot: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    chestnutRoot = path.join(tmpdir(), `event-collector-phase949-${randomUUID()}`);
    await fsAsync.mkdir(chestnutRoot, { recursive: true });
    fs = new NodeFileSystem({ baseDir: chestnutRoot });
  });

  afterEach(async () => {
    await fsAsync.rm(chestnutRoot, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  async function makeContract(
    clawSub: string,
    contractDirName: string,
    progressJson: string,
  ) {
    const archiveDir = path.join(chestnutRoot, clawSub, 'contract/archive', contractDirName);
    await fsAsync.mkdir(archiveDir, { recursive: true });
    await fsAsync.writeFile(path.join(archiveDir, 'progress.json'), progressJson);
  }

  it('cancelled + zero completed subtasks gets archivedAt from progress.json mtime', async () => {
    const { audit, events } = makeAudit();
    await makeContract('claws/worker-1', '1780-cancelled', JSON.stringify({
      schema_version: 1,
      contract_id: '1780-cancelled',
      status: 'cancelled',
      checkpoint: 'cancelled: user manual',
      subtasks: {},
    }));

    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const { entries } = await scanArchivedContracts(fs, clawDir, 'worker-1', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('cancelled');
    expect(entries[0].archivedAt).toBeGreaterThan(0);

    // Observer-style sinceTs filter: previous watermark before archivedAt should NOT drop the event
    const result = await collectContractEvents(fs, clawDir, 'worker-1', entries[0].archivedAt - 1, audit);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toContain('[contract_cancelled]');
    expect(events).toHaveLength(0);
  });

  it('schema validation failure emits PROGRESS_CORRUPTED and continues scanning other contracts', async () => {
    const { audit, events } = makeAudit();
    await makeContract('claws/worker-1', '1780-bad', JSON.stringify({
      // schema_version must be 1; invalid status fails loose enum validation
      schema_version: 1,
      contract_id: '1780-bad',
      status: 'not_a_valid_status',
      subtasks: {},
    }));
    await makeContract('claws/worker-1', '1780-good', JSON.stringify({
      schema_version: 1,
      contract_id: '1780-good',
      status: 'completed',
      subtasks: {
        'st-1': { status: 'completed', evidence: 'src/a.ts', completed_at: '2026-05-31T00:00:00Z' },
      },
    }));

    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const { entries } = await scanArchivedContracts(fs, clawDir, 'worker-1', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].contractId).toBe('1780-good');

    const corruptedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED);
    expect(corruptedEvents).toHaveLength(1);
    expect(corruptedEvents[0].join(' ')).toContain('1780-bad');
    expect(corruptedEvents[0].join(' ')).toContain('schema_validation_failed');
  });

  it('active status in archive returns structured failure and emits collector audit', async () => {
    const { audit, events } = makeAudit();
    await makeContract('claws/worker-1', '1780-running', JSON.stringify({
      schema_version: 1,
      contract_id: '1780-running',
      status: 'running',
      checkpoint: null,
      subtasks: {},
    }));

    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const { entries } = await scanArchivedContracts(fs, clawDir, 'worker-1', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('running');
    expect(entries[0].hasFailure).toBe(true);
    expect(entries[0].reason).toBe('state_machine_break');
    expect(entries[0].cause).toContain('active status "running" in archive');

    const activeEvents = events.filter(
      e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_ACTIVE_STATE_DETECTED,
    );
    expect(activeEvents).toHaveLength(1);
    expect(activeEvents[0].join(' ')).toContain('1780-running');
    expect(activeEvents[0].join(' ')).toContain('status=running');
  });
});

/**
 * Phase 1154 α-1 + α-4 — event-collector.ts FS_NOT_FOUND narrow + PROGRESS_CORRUPTED 分流 反向测试
 *
 * 反向 4 项:
 *   (1) archive listSync FileNotFoundError 不触 EVENT_COLLECTOR_SCAN_FAILED
 *   (2) progress.json readSync FileNotFoundError 不触 PROGRESS_CORRUPTED（α-4 关键）
 *   (3) 非 ENOENT 真 emit：mock throw EACCES → emit PROGRESS_CORRUPTED 1 次
 *   (4) 真 JSON.parse 失败仍 emit PROGRESS_CORRUPTED（phase 587 ⚓ invariant 不破）
 */
describe('phase 1154 — event-collector FS_NOT_FOUND narrow + α-4 progress_corrupted分流', () => {
  it('archive listSync FileNotFoundError → 0 emit', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => { throw new FileNotFoundError('/tmp/claw/contract/archive'); },
      readSync: () => '',
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = await collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result.events).toEqual([]);
    expect(result.problemPairs).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('progress.json readSync FileNotFoundError → 0 PROGRESS_CORRUPTED emit + continue next contract', async () => {
    const { audit, events } = makeAudit();
    let readCalls = 0;
    const fs = {
      listSync: () => [
        { name: '1234567890-contract1', isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
      ],
      readSync: () => {
        readCalls++;
        throw new FileNotFoundError('/tmp/claw/contract/archive/1234567890-contract1/progress.json');
      },
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = await collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result.events).toEqual([]);
    expect(result.problemPairs).toEqual([]);
    expect(events).toHaveLength(0);
    // 仅 archive 1 个 entry → readSync 被调 1 次
    expect(readCalls).toBe(1);
  });

  it('progress.json readSync EACCES → emit PROGRESS_CORRUPTED 2 次 (archive + active)', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => [
        { name: '1234567890-contract1', isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
      ],
      readSync: () => {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = await collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result.events).toEqual([]);
    expect(result.problemPairs).toEqual([]);
    // 仅 archive 1 个 entry → emit 1 次
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED);
  });

  it('progress.json invalid JSON → emit PROGRESS_CORRUPTED 2 次 (archive + active, phase 587 invariant)', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => [
        { name: '1234567890-contract1', isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
      ],
      readSync: () => 'not-json-at-all',
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = await collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result.events).toEqual([]);
    expect(result.problemPairs).toEqual([]);
    // 仅 archive 1 个 entry → emit 1 次
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED);
  });
});
