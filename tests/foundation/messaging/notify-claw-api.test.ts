/**
 * notifyClaw API tests (phase 1334 r138 E fork)
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
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';

describe('notifyClaw API', () => {
  let clawforumRoot: string;
  let nodeFs: NodeFileSystem;
  const auditEvents: Array<[string, ...(string | number)[]]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => {
      auditEvents.push([type, ...cols]);
    },
  };

  beforeEach(async () => {
    clawforumRoot = path.join(tmpdir(), `notify-claw-api-${randomUUID()}`);
    await fs.rm(clawforumRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawforumRoot, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawforumRoot });
    auditEvents.length = 0;
  });

  afterEach(async () => {
    await fs.rm(clawforumRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("notifyClaw('motion', ...) writes to motion/inbox/pending with correct codec", () => {
    notifyClaw(nodeFs, clawforumRoot, 'motion', {
      type: 'heartbeat',
      source: 'system',
      priority: 'low',
      body: 'heartbeat-body-sample',   // phase 1419: body field generic test sample (heartbeat sender uses empty string in prod)
      idPrefix: 'hb',
    }, audit);

    const motionInboxDir = path.join(clawforumRoot, 'motion', 'inbox', 'pending');
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
    await fs.mkdir(path.join(clawforumRoot, 'claws', 'worker-1'), { recursive: true });

    notifyClaw(nodeFs, clawforumRoot, 'worker-1', {
      type: 'test_message',
      source: 'test',
      priority: 'normal',
      body: 'hello worker',
    }, audit);

    const targetInboxDir = path.join(clawforumRoot, 'claws', 'worker-1', 'inbox', 'pending');
    const files = fsSync.readdirSync(targetInboxDir);
    expect(files.length).toBe(1);

    const content = fsSync.readFileSync(path.join(targetInboxDir, files[0]), 'utf8');
    expect(content).toMatch(/type: test_message/);
    expect(content).toMatch(/from: "test"/);
    expect(content).toMatch(/hello worker/);
  });

  it('emits INBOX_WRITTEN audit on happy path', () => {
    notifyClaw(nodeFs, clawforumRoot, 'motion', {
      type: 'audit_test',
      source: 'system',
      body: 'audit me',
    }, audit);

    const writtenEvents = auditEvents.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN);
    expect(writtenEvents.length).toBe(1);
  });

  it('uses priority + filename convention via InboxWriter codec', () => {
    notifyClaw(nodeFs, clawforumRoot, 'motion', {
      type: 'priority_test',
      source: 'priority_src',
      priority: 'high',
      body: 'high priority body',
    }, audit);

    const motionInboxDir = path.join(clawforumRoot, 'motion', 'inbox', 'pending');
    const files = fsSync.readdirSync(motionInboxDir);
    expect(files.length).toBe(1);

    // Filename convention: <source>-<timestamp>_<priority>_<uuid8>.md
    expect(files[0]).toMatch(/^priority_src-\d{15,}_high_[a-f0-9]{8}\.md$/);
  });

  it('dedup: multiple calls produce multiple distinct files', () => {
    for (let i = 0; i < 3; i++) {
      notifyClaw(nodeFs, clawforumRoot, 'motion', {
        type: 'dedup_test',
        source: 'system',
        body: `msg ${i}`,
      }, audit);
    }

    const motionInboxDir = path.join(clawforumRoot, 'motion', 'inbox', 'pending');
    const files = fsSync.readdirSync(motionInboxDir);
    expect(files.length).toBe(3);
  });
});
