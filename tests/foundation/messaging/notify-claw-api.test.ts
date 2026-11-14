/**
 * notifyClaw API tests (phase 1334 r138 E fork, phase 705 signature update)
 *
 * Covers the src-to-src notifyClaw API, distinct from the motion LLM tool
 * notify_claw tests in notify-claw.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { notifyClaw } from '../../../src/foundation/messaging/notify.js';
import { createClawNotifier } from '../../../src/foundation/messaging/claw-notify.js';
import { CLAWS_DIR } from '../../../src/foundation/claw-identity/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';

const MOTION_CLAW_ID = 'motion';

function makeNotifyArgs(chestnutRoot: string, targetClawId: string) {
  const isMotion = targetClawId === MOTION_CLAW_ID;
  const targetClawRoot = isMotion
    ? path.join(chestnutRoot, MOTION_CLAW_ID)
    : path.join(chestnutRoot, CLAWS_DIR, targetClawId);
  return {
    targetClawRoot,
    dlqClawRoot: isMotion ? undefined : path.join(chestnutRoot, MOTION_CLAW_ID),
  };
}

describe('notifyClaw API', () => {
  let chestnutRoot: string;
  let nodeFs: NodeFileSystem;
  const auditEvents: Array<[string, ...(string | number)[]]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => {
      auditEvents.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    chestnutRoot = path.join(tmpdir(), `notify-claw-api-${randomUUID()}`);
    await fs.rm(chestnutRoot, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(chestnutRoot, { recursive: true });
    // phase 1170: motion root is owned by topology/lifecycle, not Messaging.
    await fs.mkdir(path.join(chestnutRoot, MOTION_CLAW_ID), { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: chestnutRoot });
    auditEvents.length = 0;
  });

  afterEach(async () => {
    await fs.rm(chestnutRoot, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it("notifyClaw('motion', ...) writes to motion/inbox/pending with correct codec", () => {
    const { targetClawRoot, dlqClawRoot } = makeNotifyArgs(chestnutRoot, MOTION_CLAW_ID);
    notifyClaw(nodeFs, targetClawRoot, dlqClawRoot, {
      type: 'heartbeat',
      source: 'system',
      priority: 'low',
      body: 'heartbeat-body-sample',   // phase 1419: body field generic test sample (heartbeat sender uses empty string in prod)
      idPrefix: 'hb',
    }, audit);

    const motionInboxDir = path.join(chestnutRoot, 'motion', 'inbox', 'pending');
    const files = fsSync.readdirSync(motionInboxDir);
    expect(files.length).toBe(1);

    const content = fsSync.readFileSync(path.join(motionInboxDir, files[0]), 'utf8');
    expect(content).toMatch(/^---\r?\n/);
    expect(content).toMatch(/type: heartbeat/);
    expect(content).toMatch(/from: "system"/);
    expect(content).toMatch(/priority: low/);
    expect(content).toMatch(/heartbeat-body-sample/);
  });

  it("notifyClaw('worker-1', ...) writes to claws/worker-1/inbox/pending", async () => {
    await fs.mkdir(path.join(chestnutRoot, 'claws', 'worker-1'), { recursive: true });

    const { targetClawRoot, dlqClawRoot } = makeNotifyArgs(chestnutRoot, 'worker-1');
    notifyClaw(nodeFs, targetClawRoot, dlqClawRoot, {
      type: 'test_message',
      source: 'test',
      priority: 'normal',
      body: 'hello worker',
    }, audit);

    const targetInboxDirExpected = path.join(chestnutRoot, 'claws', 'worker-1', 'inbox', 'pending');
    const files = fsSync.readdirSync(targetInboxDirExpected);
    expect(files.length).toBe(1);

    const content = fsSync.readFileSync(path.join(targetInboxDirExpected, files[0]), 'utf8');
    expect(content).toMatch(/type: test_message/);
    expect(content).toMatch(/from: "test"/);
    expect(content).toMatch(/hello worker/);
  });

  it('emits INBOX_WRITTEN audit on happy path', () => {
    const { targetClawRoot, dlqClawRoot } = makeNotifyArgs(chestnutRoot, MOTION_CLAW_ID);
    notifyClaw(nodeFs, targetClawRoot, dlqClawRoot, {
      type: 'audit_test',
      source: 'system',
      body: 'audit me',
    }, audit);

    const writtenEvents = auditEvents.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN);
    expect(writtenEvents.length).toBe(1);
  });

  it('keeps best-effort delivery while preserving early write failure audit', () => {
    const { targetClawRoot, dlqClawRoot } = makeNotifyArgs(chestnutRoot, MOTION_CLAW_ID);

    expect(() => notifyClaw(nodeFs, targetClawRoot, dlqClawRoot, {
      type: 'audit_test',
      source: 'system',
      body: 'audit me',
      extraFields: { type: 'override' },
    }, audit)).not.toThrow();

    const failedEvents = auditEvents.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITE_FAILED);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toContain('type=audit_test');
  });

  it('uses priority + filename convention via InboxWriter codec', () => {
    const { targetClawRoot, dlqClawRoot } = makeNotifyArgs(chestnutRoot, MOTION_CLAW_ID);
    notifyClaw(nodeFs, targetClawRoot, dlqClawRoot, {
      type: 'priority_test',
      source: 'priority_src',
      priority: 'high',
      body: 'high priority body',
    }, audit);

    const motionInboxDir = path.join(chestnutRoot, 'motion', 'inbox', 'pending');
    const files = fsSync.readdirSync(motionInboxDir);
    expect(files.length).toBe(1);

    // Filename convention: <source>-<timestamp>_<priority>_<messageUuid>.md
    expect(files[0]).toMatch(/^priority_src-\d{15,}_high_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/i);
  });

  it('dedup: multiple calls produce multiple distinct files', () => {
    for (let i = 0; i < 3; i++) {
      const { targetClawRoot, dlqClawRoot } = makeNotifyArgs(chestnutRoot, MOTION_CLAW_ID);
      notifyClaw(nodeFs, targetClawRoot, dlqClawRoot, {
        type: 'dedup_test',
        source: 'system',
        body: `msg ${i}`,
      }, audit);
    }

    const motionInboxDir = path.join(chestnutRoot, 'motion', 'inbox', 'pending');
    const files = fsSync.readdirSync(motionInboxDir);
    expect(files.length).toBe(3);
  });

  it('root/leaf mismatch cannot redirect delivery through a legacy resolver leaf', async () => {
    const { targetClawRoot } = makeNotifyArgs(chestnutRoot, MOTION_CLAW_ID);
    const wrongLeaf = path.join(chestnutRoot, 'other', 'inbox', 'pending');
    const notifier = createClawNotifier({
      fs: nodeFs,
      audit,
      resolveTarget: () => ({ clawRoot: targetClawRoot, inboxDir: wrongLeaf }) as never,
    });

    await notifier.notifyAsync('motion', {
      type: 'containment_test',
      source: 'system',
      body: 'root wins',
    });

    expect(fsSync.readdirSync(path.join(targetClawRoot, 'inbox', 'pending'))).toHaveLength(1);
    expect(fsSync.existsSync(wrongLeaf)).toBe(false);
  });

  it('path traversal fails in the resolver without creating an orphan directory', async () => {
    const notifier = createClawNotifier({
      fs: nodeFs,
      audit,
      resolveTarget: () => { throw new Error('invalid claw id'); },
    });

    await expect(notifier.notifyAsync('../escape', {
      type: 'containment_test',
      source: 'system',
      body: 'should not write',
    })).rejects.toThrow('invalid claw id');
    expect(fsSync.existsSync(path.join(chestnutRoot, 'escape'))).toBe(false);
    expect(fsSync.existsSync(path.join(chestnutRoot, 'claws'))).toBe(false);
  });

  it('resolver failure does not create the target root or any messaging leaf', async () => {
    const { targetClawRoot } = makeNotifyArgs(chestnutRoot, 'worker-1');
    const notifier = createClawNotifier({
      fs: nodeFs,
      audit,
      resolveTarget: () => { throw new Error('resolution unavailable'); },
    });

    await expect(notifier.notifyAsync('worker-1', {
      type: 'containment_test',
      source: 'system',
      body: 'should not write',
    })).rejects.toThrow('resolution unavailable');
    expect(fsSync.existsSync(targetClawRoot)).toBe(false);
    expect(fsSync.existsSync(path.join(chestnutRoot, 'claws'))).toBe(false);
  });
});
