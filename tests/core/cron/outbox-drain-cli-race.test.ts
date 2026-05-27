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
import { createMessaging } from '../../../src/foundation/messaging/index.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';

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

  function makeMessaging() {
    return createMessaging({ clawforumRoot: clawforumDir, fs, audit });
  }

  // reverse 1: cron + CLI concurrent drain → 0 double-delivery invariant
  it('reverse 1: cron + CLI concurrent drain → only one delivers / 0 double-delivery', async () => {
    const content = encodeOutbox({
      id: 'race-1', type: 'question', from: 'test-claw', to: 'motion',
      content: 'concurrent', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    });
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

    // Run both concurrently to maximize race probability
    await Promise.all([
      runOutboxDrain({ messaging: makeMessaging(), audit }),
      outboxCommand({ fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }) }, 'test-claw', { limit: 99 }, { audit }),
    ]);

    console.log = origLog;

    // 0 double-delivery: either inbox has the file (cron won) OR stdout has content (CLI won), never both
    const inboxFiles = fsNative.readdirSync(motionInboxDir);
    const hasStdoutContent = logs.some(l => l.includes('concurrent'));
    expect(inboxFiles.length + (hasStdoutContent ? 1 : 0)).toBeLessThanOrEqual(1);

    // pending must be empty (atomic claim ensures one side always consumes)
    expect(fsNative.readdirSync(outboxPending)).toHaveLength(0);
  });

  // reverse 2: cron race loser → ENOENT graceful skip (drainOutboxes handles lost race internally)
  it('reverse 2: cron race loser ENOENT graceful skip', async () => {
    const content = encodeOutbox({
      id: 'race-2', type: 'question', from: 'test-claw', to: 'motion',
      content: 'loser', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    });
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    const messaging = makeMessaging();
    const origDrainOutboxes = messaging.drainOutboxes.bind(messaging);
    messaging.drainOutboxes = async (opts) => {
      // Simulate lost race by intercepting fs.move inside drainOutboxes
      const origMove = fs.move.bind(fs);
      let moveCallCount = 0;
      fs.move = async (fromPath: string, toPath: string) => {
        moveCallCount++;
        if (moveCallCount === 1 && String(fromPath).endsWith('msg1.md')) {
          throw new FileNotFoundError(fromPath);
        }
        return origMove(fromPath, toPath);
      };
      try {
        return await origDrainOutboxes(opts);
      } finally {
        fs.move = origMove;
      }
    };

    await runOutboxDrain({ messaging, audit });

    // No delivery to motion inbox because cron lost the race
    expect(fsNative.readdirSync(motionInboxDir)).toHaveLength(0);
  });

  // reverse 2b: CLI race loser → ENOENT graceful skip + RACE_LOST audit
  it('reverse 2b: CLI race loser ENOENT graceful skip + RACE_LOST audit', async () => {
    const content = encodeOutbox({
      id: 'race-3', type: 'question', from: 'test-claw', to: 'motion',
      content: 'cli-loser', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    });
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    const clawDirForOutbox = path.join(clawforumDir, 'claws', 'test-claw');
    const clawFs = new NodeFileSystem({ baseDir: clawDirForOutbox });
    const origMove = clawFs.move.bind(clawFs);
    let moveCallCount = 0;
    const moveSpy = vi.spyOn(clawFs, 'move').mockImplementation(async (oldPath: string, newPath: string) => {
      moveCallCount++;
      const oldPathStr = String(oldPath);
      // Intercept the first atomic-claim move (pending → processing) to simulate race lost
      if (moveCallCount === 1 && oldPathStr.endsWith('msg1.md')) {
        const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return origMove(oldPath, newPath);
    });

    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

    try {
      await outboxCommand({ fsFactory: () => clawFs }, 'test-claw', { limit: 99 }, { audit });
    } finally {
      console.log = origLog;
      moveSpy.mockRestore();
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
    const content = encodeOutbox({
      id: 'leftover', type: 'question', from: 'test-claw', to: 'motion',
      content: 'crash-mid-process', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    });
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    // Pre-populate processing with a simulated crash leftover
    fsNative.mkdirSync(outboxProcessing, { recursive: true });
    fsNative.writeFileSync(path.join(outboxProcessing, 'old_claim_msg1.md'), content);

    await runOutboxDrain({ messaging: makeMessaging(), audit });

    // New msg1.md should be drained normally (winner claim)
    expect(fsNative.readdirSync(motionInboxDir)).toHaveLength(1);

    // Old leftover should still be there (not auto-cleaned yet; boot-replay anchor)
    const processingFiles = fsNative.readdirSync(outboxProcessing);
    expect(processingFiles.some(f => f.startsWith('old_claim_'))).toBe(true);
  });
});
