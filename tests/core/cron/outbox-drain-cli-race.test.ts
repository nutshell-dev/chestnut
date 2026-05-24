import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { runOutboxDrain } from '../../../src/core/cron/jobs/outbox-drain.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../../src/foundation/audit/writer.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import { CLI_AUDIT_EVENTS } from '../../../src/cli/audit-events.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import { outboxCommand } from '../../../src/cli/commands/claw-outbox.js';

describe('phase 1222 r131 E fork α-2: outbox-drain ↔ CLI race atomic claim', () => {
  let rootDir: string;
  let clawforumDir: string;
  let motionInboxDir: string;
  let clawDir: string;
  let outboxPending: string;
  let outboxDone: string;
  let outboxProcessing: string;
  let fs: NodeFileSystem;
  let audit: AuditWriter;
  let prevRoot: string | undefined;
  let origLog: typeof console.log;

  beforeEach(() => {
    rootDir = path.join(os.tmpdir(), `outbox-race-${randomUUID()}`);
    clawforumDir = path.join(rootDir, '.clawforum');
    motionInboxDir = path.join(clawforumDir, 'motion', 'inbox', 'pending');
    clawDir = path.join(clawforumDir, 'claws', 'test-claw');
    outboxPending = path.join(clawDir, 'outbox', 'pending');
    outboxDone = path.join(clawDir, 'outbox', 'done');
    outboxProcessing = path.join(clawDir, 'outbox', 'processing');
    fsNative.mkdirSync(motionInboxDir, { recursive: true });
    fsNative.mkdirSync(outboxPending, { recursive: true });
    fs = new NodeFileSystem({ baseDir: clawforumDir });
    audit = new AuditWriter(fs, 'motion/audit.tsv');
    prevRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = rootDir;
    origLog = console.log;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    console.log = origLog;
    fsNative.rmSync(rootDir, { recursive: true, force: true });
    if (prevRoot === undefined) delete process.env.CLAWFORUM_ROOT;
    else process.env.CLAWFORUM_ROOT = prevRoot;
  });

  // reverse 1: cron + CLI concurrent drain → 0 double-delivery invariant
  it('reverse 1: cron + CLI concurrent drain → only one delivers / 0 double-delivery', async () => {
    const content = '# Race test\nconcurrent';
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

    // Run both concurrently to maximize race probability
    await Promise.all([
      runOutboxDrain({ clawforumDir, motionInboxDir, fs, audit }),
      outboxCommand('test-claw', { limit: 99 }, { audit }),
    ]);

    console.log = origLog;

    // 0 double-delivery: either inbox has the file (cron won) OR stdout has content (CLI won), never both
    const inboxFiles = fsNative.readdirSync(motionInboxDir);
    const hasStdoutContent = logs.some(l => l.includes('concurrent'));
    expect(inboxFiles.length + (hasStdoutContent ? 1 : 0)).toBeLessThanOrEqual(1);

    // pending must be empty (atomic claim ensures one side always consumes)
    expect(fsNative.readdirSync(outboxPending)).toHaveLength(0);

    // If a race occurred, exactly one RACE_LOST should be emitted;
    // if no race (one finished before the other started), 0 RACE_LOST is also valid.
    const auditContent = fsNative.readFileSync(path.join(clawforumDir, 'motion', 'audit.tsv'), 'utf-8');
    const raceLostCount = (auditContent.match(/outbox_drain_race_lost|claw_outbox_drain_race_lost/g) || []).length;
    expect(raceLostCount).toBeLessThanOrEqual(1);
  });

  // reverse 2: cron race loser → ENOENT graceful skip + RACE_LOST audit
  it('reverse 2: cron race loser ENOENT graceful skip + RACE_LOST audit', async () => {
    const content = '# Race test\nloser';
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    const origMove = fs.move.bind(fs);
    let moveCallCount = 0;
    fs.move = async (fromPath: string, toPath: string) => {
      moveCallCount++;
      // Intercept the first atomic-claim move (pending → processing) to simulate race lost
      if (moveCallCount === 1 && fromPath.endsWith('msg1.md')) {
        throw new FileNotFoundError(fromPath);
      }
      return origMove(fromPath, toPath);
    };

    await runOutboxDrain({ clawforumDir, motionInboxDir, fs, audit });

    // No delivery to motion inbox because cron lost the race
    expect(fsNative.readdirSync(motionInboxDir)).toHaveLength(0);

    // Audit must record RACE_LOST with file name
    const auditContent = fsNative.readFileSync(path.join(clawforumDir, 'motion', 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_RACE_LOST);
    expect(auditContent).toContain('file=msg1.md');
  });

  // reverse 2b: CLI race loser → ENOENT graceful skip + RACE_LOST audit
  it('reverse 2b: CLI race loser ENOENT graceful skip + RACE_LOST audit', async () => {
    const content = '# Race test\ncli-loser';
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    const origRename = fsNative.promises.rename;
    let renameCallCount = 0;
    (fsNative.promises as any).rename = async (oldPath: string, newPath: string) => {
      renameCallCount++;
      const oldPathStr = String(oldPath);
      // Intercept the first atomic-claim rename (pending → processing) to simulate race lost
      if (renameCallCount === 1 && oldPathStr.endsWith('msg1.md')) {
        const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return origRename(oldPath, newPath);
    };

    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

    try {
      await outboxCommand('test-claw', { limit: 99 }, { audit });
    } finally {
      console.log = origLog;
      (fsNative.promises as any).rename = origRename;
    }

    // No stdout content because CLI lost the race
    expect(logs.some(l => l.includes('cli-loser'))).toBe(false);

    // Audit must record RACE_LOST with file name
    const auditContent = fsNative.readFileSync(path.join(clawforumDir, 'motion', 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_RACE_LOST);
    expect(auditContent).toContain('file=msg1.md');
  });

  // reverse 3: processing/ leftover file survives across drains (boot replay anchor)
  it('reverse 3: processing/ leftover file survives across drains (boot replay anchor)', async () => {
    const content = '# Leftover\ncrash-mid-process';
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    // Pre-populate processing with a simulated crash leftover
    fsNative.mkdirSync(outboxProcessing, { recursive: true });
    fsNative.writeFileSync(path.join(outboxProcessing, 'old_claim_msg1.md'), content);

    await runOutboxDrain({ clawforumDir, motionInboxDir, fs, audit });

    // New msg1.md should be drained normally (winner claim)
    expect(fsNative.readdirSync(motionInboxDir)).toHaveLength(1);

    // Old leftover should still be there (not auto-cleaned yet; boot-replay anchor)
    const processingFiles = fsNative.readdirSync(outboxProcessing);
    expect(processingFiles.some(f => f.startsWith('old_claim_'))).toBe(true);
  });
});
