import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { notifyClaw } from '../../../src/foundation/messaging/notify.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';
import { CLAWS_DIR } from '../../../src/foundation/claw-identity/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

const MOTION_CLAW_ID = 'motion';

function makeNotifyArgs(tempDir: string, targetClawId: string) {
  const isMotion = targetClawId === MOTION_CLAW_ID;
  const targetClawRoot = isMotion
    ? path.join(tempDir, MOTION_CLAW_ID)
    : path.join(tempDir, CLAWS_DIR, targetClawId);
  return {
    targetClawRoot,
    targetInboxDir: path.join(targetClawRoot, INBOX_PENDING_DIR),
    dlqDir: isMotion ? undefined : path.join(tempDir, MOTION_CLAW_ID, 'inbox', 'dead-letter'),
  };
}

describe('dead letter queue (phase 1372 sub-4)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('unknown targetClawId → writes to motion/inbox/dead-letter/ + emits UNKNOWN_DESTINATION_DLQ', () => {
    // Do NOT create claws/ghost-claw — simulate unknown destination
    const { targetClawRoot, targetInboxDir, dlqDir } = makeNotifyArgs(tempDir, 'ghost-claw');
    notifyClaw(fs, targetClawRoot, targetInboxDir, dlqDir, {
      type: 'message',
      source: 'motion',
      priority: 'normal',
      body: 'orphan message',
    }, audit.audit);

    // Verify DLQ dir created and file written
    const dlqDirExpected = path.join(tempDir, 'motion', 'inbox', 'dead-letter');
    const dlqFiles = fs.listSync(path.join('motion', 'inbox', 'dead-letter'));
    expect(dlqFiles.length).toBe(1);

    const content = fs.readSync(path.join('motion', 'inbox', 'dead-letter', dlqFiles[0].name));
    expect(content).toMatch(/orphan message/);
    expect(content).toMatch(/from: "motion"/);

    // Verify audit emit
    const dlqEvent = audit.events.find(e => e[0] === MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_DLQ);
    expect(dlqEvent).toBeDefined();
    expect(dlqEvent).toContain('target_claw_id=ghost-claw');
    expect(dlqEvent).toContain('reason=claw_not_found');
  });

  it('unknown targetClawId → 0 silent routing motion (no orphan claw dir created)', () => {
    const { targetClawRoot, targetInboxDir, dlqDir } = makeNotifyArgs(tempDir, 'nonexistent-claw');
    notifyClaw(fs, targetClawRoot, targetInboxDir, dlqDir, {
      type: 'message',
      source: 'motion',
      priority: 'normal',
      body: 'test',
    }, audit.audit);

    // claws/nonexistent-claw must NOT exist
    const orphanRoot = path.join(tempDir, 'claws', 'nonexistent-claw');
    expect(fs.existsSync(orphanRoot)).toBe(false);

    // DLQ file must exist
    const dlqFiles = fs.listSync(path.join('motion', 'inbox', 'dead-letter'));
    expect(dlqFiles.length).toBe(1);
  });

  it('known targetClawId → normal inbox delivery, no DLQ', () => {
    // Pre-create target claw
    fs.ensureDirSync(path.join('claws', 'known-claw'));

    const { targetClawRoot, targetInboxDir, dlqDir } = makeNotifyArgs(tempDir, 'known-claw');
    notifyClaw(fs, targetClawRoot, targetInboxDir, dlqDir, {
      type: 'message',
      source: 'motion',
      priority: 'normal',
      body: 'normal delivery',
    }, audit.audit);

    // Verify normal inbox delivery
    const inboxFiles = fs.listSync(path.join('claws', 'known-claw', 'inbox', 'pending'));
    expect(inboxFiles.length).toBe(1);

    // Verify no DLQ event
    const dlqEvents = audit.events.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_DLQ);
    expect(dlqEvents.length).toBe(0);

    // Verify no DLQ dir created
    expect(fs.existsSync(path.join('motion', 'inbox', 'dead-letter'))).toBe(false);
  });

  it('motion targetClawId → normal motion inbox delivery, no DLQ', () => {
    // phase 1170: motion root must exist; Messaging no longer owns claw root creation.
    fs.ensureDirSync(MOTION_CLAW_ID);

    const { targetClawRoot, targetInboxDir, dlqDir } = makeNotifyArgs(tempDir, MOTION_CLAW_ID);
    notifyClaw(fs, targetClawRoot, targetInboxDir, dlqDir, {
      type: 'message',
      source: 'system',
      priority: 'high',
      body: 'motion internal',
    }, audit.audit);

    const motionInboxFiles = fs.listSync(path.join('motion', 'inbox', 'pending'));
    expect(motionInboxFiles.length).toBe(1);

    const dlqEvents = audit.events.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_DLQ);
    expect(dlqEvents.length).toBe(0);

    const rejectedEvents = audit.events.filter(
      e => e[0] === MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_REJECTED,
    );
    expect(rejectedEvents.length).toBe(0);
  });

  it('missing target without DLQ rejects without creating an orphan root', () => {
    const { targetClawRoot, targetInboxDir } = makeNotifyArgs(tempDir, MOTION_CLAW_ID);

    notifyClaw(fs, targetClawRoot, targetInboxDir, undefined, {
      type: 'message',
      source: 'system',
      body: 'must not be written',
    }, audit.audit);

    expect(fs.existsSync(path.join(tempDir, MOTION_CLAW_ID))).toBe(false);
    expect(audit.events.filter(
      e => e[0] === MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_REJECTED,
    )).toEqual([[
      MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_REJECTED,
      'target_claw_id=motion',
      'reason=claw_not_found',
      'fallback=unavailable',
    ]]);
    expect(audit.events.some(
      e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN,
    )).toBe(false);
  });

  it('rejected audit failure still fail-closed', () => {
    const { targetClawRoot, targetInboxDir } = makeNotifyArgs(tempDir, MOTION_CLAW_ID);
    const message = {
      type: 'message',
      source: 'system',
      body: 'must not be written',
    } as const;
    const throwingAudit = {
      ...audit.audit,
      write: () => {
        throw new Error('audit unavailable');
      },
    };

    expect(() => notifyClaw(
      fs,
      targetClawRoot,
      targetInboxDir,
      undefined,
      message,
      throwingAudit,
    )).not.toThrow();
    expect(fs.existsSync(targetClawRoot)).toBe(false);
  });
});
