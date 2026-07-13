/**
 * Phase 442 (review N3-C-H1 / R2-C-N1): InboxReader markMisrouted +
 * misrouted/ dir lifecycle reverse tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxReader, InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';
import { InboxMoveFailed } from '../../../src/foundation/messaging/errors.js';

describe('InboxReader markMisrouted (phase 442)', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: Array<{ type: string; cols: string[] }>;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `inbox-misrouted-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    const audit = {
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

  async function writeMsg(id: string, to: string, body: string) {
    await writer.write({
      id,
      type: 'message',
      from: 'sender',
      to,
      content: body,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Case 1: init creates misrouted/ subdir ──────────────────────────────
  it('init() creates misrouted/ subdirectory', async () => {
    const misroutedStat = await fs.stat(path.join(testDir, 'inbox', 'misrouted')).catch(() => null);
    expect(misroutedStat).not.toBeNull();
    expect(misroutedStat!.isDirectory()).toBe(true);
  });

  // ─── Case 2: markMisrouted moves inflight → misrouted + audit ───────────
  it('markMisrouted moves inflight file to misrouted/ and emits INBOX_MISROUTED', async () => {
    await writeMsg('msg-1', 'other-claw', 'hello');
    const { handles } = await reader.drainAndDeliver();
    expect(handles).toHaveLength(1);

    await reader.markMisrouted(handles[0]);

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles.filter(f => f.endsWith('.md'))).toHaveLength(0);

    const misroutedFiles = await fs.readdir(path.join(testDir, 'inbox', 'misrouted'));
    expect(misroutedFiles).toHaveLength(1);
    expect(misroutedFiles[0]).toMatch(/^\d+_[a-f0-9]{8}_.+\.md$/);

    const misroutedAudit = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_MISROUTED);
    expect(misroutedAudit).toHaveLength(1);
    expect(misroutedAudit[0].cols.some(c => c.startsWith('file='))).toBe(true);
  });

  // ─── Case 3: markMisrouted move failure throws InboxMoveFailed + audit ──
  it('markMisrouted throws InboxMoveFailed when fs.move fails, emits INBOX_MOVE_FAILED with op=misrouted', async () => {
    await writeMsg('msg-1', 'other-claw', 'hello');
    const { handles } = await reader.drainAndDeliver();

    // Inject failure: rm the misrouted dir so move target dir disappears
    await fs.rm(path.join(testDir, 'inbox', 'misrouted'), { recursive: true, force: true });
    // Also rm the file from inflight so source missing — simulates concurrent disappearance
    await fs.rm(handles[0].filePath, { force: true });

    await expect(reader.markMisrouted(handles[0])).rejects.toBeInstanceOf(InboxMoveFailed);

    const moveFailedAudit = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_MOVE_FAILED);
    expect(moveFailedAudit.length).toBeGreaterThanOrEqual(1);
    const misroutedOp = moveFailedAudit.find(c => c.cols.some(col => col === 'op=misrouted'));
    expect(misroutedOp).toBeDefined();
  });
});
