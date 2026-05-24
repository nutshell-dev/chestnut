import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { runOutboxDrain } from '../../../src/core/cron/jobs/outbox-drain.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../../src/foundation/audit/writer.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';

describe('outbox-drain cron job (phase 1160 P0-2)', () => {
  let clawforumDir: string;
  let motionInboxDir: string;
  let clawDir: string;
  let outboxPending: string;
  let outboxDone: string;
  let fs: NodeFileSystem;
  let audit: AuditWriter;

  beforeEach(() => {
    clawforumDir = path.join(os.tmpdir(), `outbox-drain-${randomUUID()}`);
    motionInboxDir = path.join(clawforumDir, 'motion', 'inbox', 'pending');
    clawDir = path.join(clawforumDir, 'claws', 'test-claw');
    outboxPending = path.join(clawDir, 'outbox', 'pending');
    outboxDone = path.join(clawDir, 'outbox', 'done');
    fsNative.mkdirSync(motionInboxDir, { recursive: true });
    fsNative.mkdirSync(outboxPending, { recursive: true });
    fs = new NodeFileSystem({ baseDir: clawforumDir });
    audit = new AuditWriter(fs, 'motion/audit.tsv');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fsNative.rmSync(clawforumDir, { recursive: true, force: true });
  });

  // 反向 1: outbox pending → motion inbox real delivery (production wiring)
  it('反向 1: outbox pending → motion inbox real delivery', async () => {
    const content = '# Test message\nhello motion';
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    await runOutboxDrain({ clawforumDir, motionInboxDir, fs, audit });

    const inboxFiles = fsNative.readdirSync(motionInboxDir);
    expect(inboxFiles).toHaveLength(1);
    expect(fsNative.readFileSync(path.join(motionInboxDir, inboxFiles[0]), 'utf-8')).toBe(content);
  });

  // 反向 2: pending → done atomic move (0 remaining + 1 done)
  it('反向 2: pending → done atomic move (0 remaining + 1 done)', async () => {
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), 'msg');
    await runOutboxDrain({ clawforumDir, motionInboxDir, fs, audit });

    expect(fsNative.readdirSync(outboxPending)).toHaveLength(0);
    const doneFiles = fsNative.readdirSync(outboxDone);
    expect(doneFiles).toHaveLength(1);
    expect(doneFiles[0]).toMatch(/^\d+_.*_msg1\.md$/);
  });

  // 反向 3: OUTBOX_DRAIN_START + DONE audit emit + count 字段正确
  it('反向 3: OUTBOX_DRAIN_START + DONE audit emit with correct count', async () => {
    fsNative.writeFileSync(path.join(outboxPending, 'a.md'), 'a');
    fsNative.writeFileSync(path.join(outboxPending, 'b.md'), 'b');

    await runOutboxDrain({ clawforumDir, motionInboxDir, fs, audit });

    const auditContent = fsNative.readFileSync(path.join(clawforumDir, 'motion', 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_START);
    expect(auditContent).toContain(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE);
    expect(auditContent).toContain('total=2');
  });

  // 边界: 无 outbox → 不 crash、0 emit
  it('边界: 无 claws → 不 crash、audit 仅 DONE total=0', async () => {
    fsNative.rmSync(clawDir, { recursive: true, force: true });
    await runOutboxDrain({ clawforumDir, motionInboxDir, fs, audit });

    const auditContent = fsNative.readFileSync(path.join(clawforumDir, 'motion', 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_START);
    expect(auditContent).toContain('total=0');
  });

  // 边界: limit 截断
  it('边界: limit 截断超额 outbox', async () => {
    fsNative.writeFileSync(path.join(outboxPending, '1.md'), '1');
    fsNative.writeFileSync(path.join(outboxPending, '2.md'), '2');
    fsNative.writeFileSync(path.join(outboxPending, '3.md'), '3');

    await runOutboxDrain({ clawforumDir, motionInboxDir, fs, audit, limit: 2 });

    expect(fsNative.readdirSync(outboxPending)).toHaveLength(1);
    expect(fsNative.readdirSync(motionInboxDir)).toHaveLength(2);
  });
});
