/**
 * Phase 930: inbox branded handle + inflight claim lease + transient error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxReader, InboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../../src/foundation/messaging/dirs.js';
import { getProcessStartTime } from '../../../src/foundation/process-exec/index.js';
import type { InboxHandle } from '../../../src/foundation/messaging/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

describe('InboxReader phase 930', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: Array<{ type: string; cols: string[] }>;
  let audit: { write(type: string, ...cols: (string | number)[]): void };
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `inbox-p930-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push({ type, cols: cols.map(String) });
      },
    };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit);
    reader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      audit,
    );
    await reader.init();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  async function writeMsg(id: string, body: string) {
    await writer.write({
      id,
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: body,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Case 1: forged handle with path traversal → throw ────────────────────
  it('rejects forged handle with path traversal', async () => {
    const forged = { filePath: '../../../etc/passwd', originalFileName: 'test.md' } as InboxHandle;
    await expect(reader.ack(forged)).rejects.toThrow(/traversal/i);
    await expect(reader.nack(forged)).rejects.toThrow(/traversal/i);
    await expect(reader.markMisrouted(forged)).rejects.toThrow(/traversal/i);
  });

  // ─── Case 2: alive inflight claim → not reclaimed ─────────────────────────
  it('does not reclaim inflight with alive PID and matching startTime', async () => {
    await writeMsg('msg-1', 'hello');
    const pid = process.pid;
    const startTime = getProcessStartTime(pid);
    const startTimeHex = startTime ? Buffer.from(startTime).toString('hex') : '0';

    // Move pending file to inflight using the claim-lease format.
    const pendingDir = path.join(testDir, 'inbox', 'pending');
    const inflightDir = path.join(testDir, 'inbox', 'inflight');
    const files = await fs.readdir(pendingDir);
    const originalName = files.find(f => f.endsWith('.md'))!;
    await fs.rename(
      path.join(pendingDir, originalName),
      path.join(inflightDir, `${pid}_${startTimeHex}_${originalName}`),
    );

    // Create a fresh reader; init() should leave the alive claim alone.
    const freshAuditCalls: Array<{ type: string; cols: string[] }> = [];
    const freshAudit = {
      write(type: string, ...cols: (string | number)[]) {
        freshAuditCalls.push({ type, cols: cols.map(String) });
      },
    };
    const freshReader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      freshAudit,
    );
    await freshReader.init();

    const pendingFiles = await fs.readdir(pendingDir);
    expect(pendingFiles.filter(f => f.endsWith('.md'))).toHaveLength(0);

    const inflightFiles = await fs.readdir(inflightDir);
    expect(inflightFiles).toHaveLength(1);

    const reconcileAudit = freshAuditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RECONCILE);
    expect(reconcileAudit).toHaveLength(0);
  });

  // ─── Case 3: startTime=0 with expired mtime lease → reclaim ───────────────
  it('reclaims inflight when startTime=0 and mtime lease expired', async () => {
    await writeMsg('msg-1', 'hello');
    const pid = process.pid;

    const pendingDir = path.join(testDir, 'inbox', 'pending');
    const inflightDir = path.join(testDir, 'inbox', 'inflight');
    const files = await fs.readdir(pendingDir);
    const originalName = files.find(f => f.endsWith('.md'))!;
    const inflightPath = path.join(inflightDir, `${pid}_0_${originalName}`);
    await fs.rename(path.join(pendingDir, originalName), inflightPath);

    // Backdate mtime beyond STALE_THRESHOLD_MS (5 minutes)
    const oldMtime = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(inflightPath, oldMtime, oldMtime);

    const freshReader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      audit,
    );
    await freshReader.init();

    const pendingFiles = (await fs.readdir(pendingDir)).filter(f => f.endsWith('.md'));
    expect(pendingFiles).toHaveLength(1);
  });

  // ─── Case 4: startTime=0 with recent mtime → keep inflight ──────────────────
  it('keeps inflight when startTime=0 but mtime lease has not expired', async () => {
    await writeMsg('msg-1', 'hello');
    const pid = process.pid;

    const pendingDir = path.join(testDir, 'inbox', 'pending');
    const inflightDir = path.join(testDir, 'inbox', 'inflight');
    const files = await fs.readdir(pendingDir);
    const originalName = files.find(f => f.endsWith('.md'))!;
    const inflightPath = path.join(inflightDir, `${pid}_0_${originalName}`);
    await fs.rename(path.join(pendingDir, originalName), inflightPath);

    // Keep recent mtime
    const recentMtime = new Date();
    await fs.utimes(inflightPath, recentMtime, recentMtime);

    const freshReader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      audit,
    );
    await freshReader.init();

    const pendingFiles = (await fs.readdir(pendingDir)).filter(f => f.endsWith('.md'));
    expect(pendingFiles).toHaveLength(0);

    const inflightFiles = await fs.readdir(inflightDir);
    expect(inflightFiles).toHaveLength(1);
  });

  // ─── Case 5: transient read error → keep pending ──────────────────────────
  it('keeps message in pending on transient read error', async () => {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        events.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };

    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const mockFs: FileSystem = {
      list: vi.fn().mockResolvedValue([{ name: 'msg.md', path: '/inbox/pending/msg.md' }]),
      read: vi.fn().mockRejectedValue(readError),
      ensureDir: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    const r = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit);
    const { entries } = await r.drainInbox();

    expect(entries).toHaveLength(0);
    const failedAudit = events.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_FAILED);
    expect(failedAudit).toHaveLength(1);
    const reasonCol = failedAudit[0].find(c => typeof c === 'string' && c.includes('transient IO error'));
    expect(reasonCol).toBeTruthy();
    const codeCol = failedAudit[0].find(c => typeof c === 'string' && c.includes('error_code=EACCES'));
    expect(codeCol).toBeTruthy();
  });

  // ─── Case 6: ENOSPC read error → keep pending (inverse whitelist) ──────────
  it('keeps message in pending on ENOSPC read error', async () => {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        events.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };

    const readError = Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    const mockFs: FileSystem = {
      list: vi.fn().mockResolvedValue([{ name: 'msg.md', path: '/inbox/pending/msg.md' }]),
      read: vi.fn().mockRejectedValue(readError),
      ensureDir: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    const r = new InboxReader('/inbox/pending', '/inbox/done', '/inbox/failed', mockFs, audit);
    const { entries } = await r.drainInbox();

    expect(entries).toHaveLength(0);
    const failedAudit = events.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_FAILED);
    expect(failedAudit).toHaveLength(1);
    const reasonCol = failedAudit[0].find(c => typeof c === 'string' && c.includes('transient IO error'));
    expect(reasonCol).toBeTruthy();
    const codeCol = failedAudit[0].find(c => typeof c === 'string' && c.includes('error_code=ENOSPC'));
    expect(codeCol).toBeTruthy();
  });
});
