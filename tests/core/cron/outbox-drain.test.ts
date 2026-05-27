import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { runOutboxDrain } from '../../../src/core/cron/jobs/outbox-drain.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../../src/foundation/audit/writer.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import { createMessaging } from '../../../src/foundation/messaging/index.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';

describe('outbox-drain cron job (phase 1160 P0-2 + phase 1333 tick trigger)', () => {
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

  function makeMessaging() {
    return createMessaging({ clawforumRoot: clawforumDir, fs, audit });
  }

  // 反向 1: outbox pending → motion inbox real delivery (production wiring)
  it('反向 1: outbox pending → motion inbox real delivery', async () => {
    const content = encodeOutbox({
      id: 'msg-1',
      type: 'question',
      from: 'test-claw',
      to: 'motion',
      content: 'hello motion',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'normal',
    });
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), content);

    await runOutboxDrain({ messaging: makeMessaging(), audit });

    const inboxFiles = fsNative.readdirSync(motionInboxDir);
    expect(inboxFiles).toHaveLength(1);
    expect(fsNative.readFileSync(path.join(motionInboxDir, inboxFiles[0]), 'utf-8')).toContain('hello motion');
  });

  // 反向 2: pending → done atomic move (0 remaining + 1 done)
  it('反向 2: pending → done atomic move (0 remaining + 1 done)', async () => {
    fsNative.writeFileSync(path.join(outboxPending, 'msg1.md'), encodeOutbox({
      id: 'msg-1',
      type: 'question',
      from: 'test-claw',
      to: 'motion',
      content: 'msg',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'normal',
    }));
    await runOutboxDrain({ messaging: makeMessaging(), audit });

    expect(fsNative.readdirSync(outboxPending)).toHaveLength(0);
    const doneFiles = fsNative.readdirSync(outboxDone);
    expect(doneFiles).toHaveLength(1);
    expect(doneFiles[0]).toMatch(/^\d+_.*_msg1\.md$/);
  });

  // 反向 3: OUTBOX_DRAIN_DONE audit emit + count 字段正确
  it('反向 3: OUTBOX_DRAIN_DONE audit emit with correct count', async () => {
    fsNative.writeFileSync(path.join(outboxPending, 'a.md'), encodeOutbox({
      id: 'a', type: 'question', from: 'test-claw', to: 'motion',
      content: 'a', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    }));
    fsNative.writeFileSync(path.join(outboxPending, 'b.md'), encodeOutbox({
      id: 'b', type: 'question', from: 'test-claw', to: 'motion',
      content: 'b', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    }));

    await runOutboxDrain({ messaging: makeMessaging(), audit });

    const auditContent = fsNative.readFileSync(path.join(clawforumDir, 'motion', 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE);
    expect(auditContent).toContain('total=2');
  });

  // 边界: 无 outbox → 不 crash、0 emit
  it('边界: 无 claws → 不 crash、audit 仅 DONE total=0', async () => {
    fsNative.rmSync(clawDir, { recursive: true, force: true });
    await runOutboxDrain({ messaging: makeMessaging(), audit });

    const auditContent = fsNative.readFileSync(path.join(clawforumDir, 'motion', 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE);
    expect(auditContent).toContain('total=0');
  });

  // 边界: limit 截断
  it('边界: limit 截断超额 outbox', async () => {
    fsNative.writeFileSync(path.join(outboxPending, '1.md'), encodeOutbox({
      id: '1', type: 'question', from: 'test-claw', to: 'motion',
      content: '1', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    }));
    fsNative.writeFileSync(path.join(outboxPending, '2.md'), encodeOutbox({
      id: '2', type: 'question', from: 'test-claw', to: 'motion',
      content: '2', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    }));
    fsNative.writeFileSync(path.join(outboxPending, '3.md'), encodeOutbox({
      id: '3', type: 'question', from: 'test-claw', to: 'motion',
      content: '3', timestamp: '2026-05-26T12:00:00.000Z', priority: 'normal',
    }));

    await runOutboxDrain({ messaging: makeMessaging(), limitPerClaw: 2, audit });

    expect(fsNative.readdirSync(outboxPending)).toHaveLength(1);
    expect(fsNative.readdirSync(motionInboxDir)).toHaveLength(2);
  });
});
