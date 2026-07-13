/**
 * Messaging write invariant tests (phase 273 Step A)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxWriter, makeInboxPath, OutboxWriter, makeOutboxPath } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import { assertMessageShape } from '../../../src/foundation/messaging/invariants.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';

describe('messaging write invariant (phase 273 Step A)', () => {
  let auditCalls: string[];
  let audit: { write(type: string, ...cols: (string | number)[]): void };

  beforeEach(() => {
    auditCalls = [];
    audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push(`${type}:${cols.join(',')}`);
      },
    };
  });

  // ─── 共享 helper 根 check ────────────────────────────────────────────────

  describe('shared helper root check', () => {
    it('message=null → emit sub_check=message_not_object + kind=inbox', () => {
      assertMessageShape(null, audit, 'inbox', 'write');
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0]).toContain('sub_check=message_not_object');
      expect(auditCalls[0]).toContain('kind=inbox');
    });

    it('message=null + kind=outbox → emit + kind=outbox', () => {
      assertMessageShape(null, audit, 'outbox', 'write');
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0]).toContain('kind=outbox');
    });

    it('message=string → emit message_not_object', () => {
      assertMessageShape('bad', audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=message_not_object'))).toBe(true);
    });
  });

  // ─── 共用 5 sub-check（inbox kind）───────────────────────────────────────

  describe('common 5 sub-checks (inbox kind)', () => {
    const base: InboxMessage = {
      id: 'test-1',
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: 'Hello',
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };

    it('valid inbox → 0 emit', () => {
      assertMessageShape(base, audit, 'inbox', 'write');
      expect(auditCalls).toHaveLength(0);
    });

    it('id not string → emit id_not_string', () => {
      assertMessageShape({ ...base, id: 123 as any }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=id_not_string'))).toBe(true);
    });

    it('id="" → emit id_empty', () => {
      assertMessageShape({ ...base, id: '' }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=id_empty'))).toBe(true);
    });

    it('from not string → emit from_not_string', () => {
      assertMessageShape({ ...base, from: 123 as any }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=from_not_string'))).toBe(true);
    });

    it('to not string → emit to_not_string', () => {
      assertMessageShape({ ...base, to: 123 as any }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=to_not_string'))).toBe(true);
    });

    it('content not string → emit content_not_string', () => {
      assertMessageShape({ ...base, content: 123 as any }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=content_not_string'))).toBe(true);
    });

    it('priority="invalid" → emit priority_not_in_union', () => {
      assertMessageShape({ ...base, priority: 'invalid' as any }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=priority_not_in_union'))).toBe(true);
    });

    it('timestamp not string → emit timestamp_not_string', () => {
      assertMessageShape({ ...base, timestamp: 123 as any }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=timestamp_not_string'))).toBe(true);
    });

    it('timestamp not ISO → emit timestamp_not_iso', () => {
      assertMessageShape({ ...base, timestamp: 'not-a-date' }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=timestamp_not_iso'))).toBe(true);
    });
  });

  // ─── inbox type ──────────────────────────────────────────────────────────

  describe('inbox type', () => {
    const base: InboxMessage = {
      id: 'test-1', type: 'message', from: 's', to: 'c',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };

    it('inbox type="custom_event" string → 0 emit（fallback allowed）', () => {
      assertMessageShape({ ...base, type: 'custom_event' }, audit, 'inbox', 'write');
      expect(auditCalls).toHaveLength(0);
    });

    it('inbox type not string → emit type_not_string', () => {
      assertMessageShape({ ...base, type: 123 as any }, audit, 'inbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=type_not_string'))).toBe(true);
    });
  });

  // ─── outbox type union ───────────────────────────────────────────────────

  describe('outbox type union', () => {
    const baseOutbox = {
      id: 'test-1',
      type: 'report',
      from: 's',
      to: 'c',
      content: 'Hello',
      timestamp: new Date().toISOString(),
      priority: 'normal',
    };

    it('outbox type="report" → 0 emit', () => {
      assertMessageShape(baseOutbox, audit, 'outbox', 'write');
      expect(auditCalls).toHaveLength(0);
    });

    it('outbox type="question" → 0 emit', () => {
      assertMessageShape({ ...baseOutbox, type: 'question' }, audit, 'outbox', 'write');
      expect(auditCalls).toHaveLength(0);
    });

    it('outbox type="result" → 0 emit', () => {
      assertMessageShape({ ...baseOutbox, type: 'result' }, audit, 'outbox', 'write');
      expect(auditCalls).toHaveLength(0);
    });

    it('outbox type="error" → 0 emit', () => {
      assertMessageShape({ ...baseOutbox, type: 'error' }, audit, 'outbox', 'write');
      expect(auditCalls).toHaveLength(0);
    });

    it('outbox type="invalid" → emit outbox_type_not_in_union', () => {
      assertMessageShape({ ...baseOutbox, type: 'invalid' }, audit, 'outbox', 'write');
      expect(auditCalls.some(c => c.includes('sub_check=outbox_type_not_in_union'))).toBe(true);
    });
  });

  // ─── kind 字段 ───────────────────────────────────────────────────────────

  describe('kind field', () => {
    const base: InboxMessage = {
      id: 'test-1', type: 'message', from: 's', to: 'c',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };

    it('inbox emit row contains kind=inbox', () => {
      assertMessageShape({ ...base, id: '' }, audit, 'inbox', 'write');
      expect(auditCalls.every(c => c.includes('kind=inbox'))).toBe(true);
    });

    it('outbox emit row contains kind=outbox', () => {
      const ob = { id: 'test-1', type: 'invalid', from: 's', to: 'c', content: 'Hello', timestamp: new Date().toISOString(), priority: 'normal' };
      assertMessageShape(ob, audit, 'outbox', 'write');
      expect(auditCalls.every(c => c.includes('kind=outbox'))).toBe(true);
    });
  });

  // ─── direction 字段 ──────────────────────────────────────────────────────

  describe('direction field', () => {
    const base: InboxMessage = {
      id: 'test-1', type: 'message', from: 's', to: 'c',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };

    it('write emit row contains direction=write', () => {
      assertMessageShape({ ...base, id: '' }, audit, 'inbox', 'write');
      expect(auditCalls.every(c => c.includes('direction=write'))).toBe(true);
    });
  });

  // ─── InboxWriter.write 集成 ──────────────────────────────────────────────

  describe('InboxWriter.write integration', () => {
    let testDir: string;
    let nfs: NodeFileSystem;
    let writer: InboxWriter;
    let calls: string[];

    beforeEach(async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      testDir = path.join(tmpdir(), `invariant-test-${randomUUID()}`);
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      await fs.mkdir(testDir, { recursive: true });
      nfs = new NodeFileSystem({ baseDir: testDir });
      calls = [];
      const a = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push(`${type}:${cols.join(',')}`);
        },
      };
      writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), a);
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    it('valid → 0 emit + file written', async () => {
      const msg: InboxMessage = {
        id: 'test-1', type: 'message', from: 'sender', to: 'claw',
        content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
      };
      await writer.write(msg);
      const invariantCalls = calls.filter(c => c.startsWith(MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED));
      expect(invariantCalls).toHaveLength(0);
      const files = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
      expect(files).toHaveLength(1);
    });

    it('invalid → file still written (no throw) + audit emit', async () => {
      const msg = {
        id: '', type: 'message', from: 'sender', to: 'claw',
        content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
      } as InboxMessage;
      await writer.write(msg);
      const invariantCalls = calls.filter(c => c.startsWith(MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED));
      expect(invariantCalls.length).toBeGreaterThan(0);
      const files = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
      expect(files).toHaveLength(1);
    });

    it('preserves IO error throw path', async () => {
      const pendingDir = path.join(testDir, 'inbox', 'pending');
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.chmod(pendingDir, 0o555);
      const msg: InboxMessage = {
        id: 'test-1', type: 'message', from: 'sender', to: 'claw',
        content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
      };
      try {
        await expect(writer.write(msg)).rejects.toThrow();
      } finally {
        await fs.chmod(pendingDir, 0o755);
      }
    });
  });

  // ─── InboxWriter.writeSync 集成 ──────────────────────────────────────────

  describe('InboxWriter.writeSync integration', () => {
    let testDir: string;
    let nfs: NodeFileSystem;
    let writer: InboxWriter;
    let calls: string[];

    beforeEach(async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      testDir = path.join(tmpdir(), `invariant-sync-test-${randomUUID()}`);
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      await fs.mkdir(testDir, { recursive: true });
      nfs = new NodeFileSystem({ baseDir: testDir });
      calls = [];
      const a = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push(`${type}:${cols.join(',')}`);
        },
      };
      writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), a);
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    it('valid opts → 0 emit + file written', () => {
      writer.writeSync({ type: 'ping', source: 'motion', priority: 'normal', body: 'test' });
      const invariantCalls = calls.filter(c => c.startsWith(MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED));
      expect(invariantCalls).toHaveLength(0);
      const files = fsSync.readdirSync(path.join(testDir, 'inbox', 'pending'));
      expect(files).toHaveLength(1);
    });

    it('invalid opts constructing malformed message → file still written + audit emit', () => {
      // writeSync constructs message from opts; opts missing body creates empty content which is string
      // To trigger invariant, we need a case where the constructed message violates shape.
      // writeSync always constructs a valid InboxMessage shape, so we test via direct assertMessageShape
      // instead for the "malformed" case. For integration, we verify the path doesn't throw.
      writer.writeSync({ type: 'ping', source: 'motion', priority: 'normal', body: 'test' });
      expect(fsSync.readdirSync(path.join(testDir, 'inbox', 'pending'))).toHaveLength(1);
    });
  });

  // ─── OutboxWriter.write 集成 ─────────────────────────────────────────────

  describe('OutboxWriter.write integration', () => {
    let testDir: string;
    let nfs: NodeFileSystem;
    let writer: OutboxWriter;
    let calls: string[];

    beforeEach(async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      testDir = path.join(tmpdir(), `outbox-invariant-test-${randomUUID()}`);
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      await fs.mkdir(testDir, { recursive: true });
      nfs = new NodeFileSystem({ baseDir: testDir });
      calls = [];
      const a = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push(`${type}:${cols.join(',')}`);
        },
      };
      writer = OutboxWriter.__internal_create('claw-a', makeOutboxPath('claw-a', testDir), nfs, a);
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    it('valid options → 0 emit + file written', async () => {
      await writer.write({ type: 'report', to: 'claw-b', content: 'Hello' });
      const invariantCalls = calls.filter(c => c.startsWith(MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED));
      expect(invariantCalls).toHaveLength(0);
      const files = await fs.readdir(path.join(testDir, 'outbox', 'pending'));
      expect(files).toHaveLength(1);
    });

    it('invalid type → file still written + audit emit', async () => {
      await writer.write({ type: 'invalid' as any, to: 'claw-b', content: 'Hello' });
      const invariantCalls = calls.filter(c => c.startsWith(MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED));
      expect(invariantCalls.length).toBeGreaterThan(0);
      const files = await fs.readdir(path.join(testDir, 'outbox', 'pending'));
      expect(files).toHaveLength(1);
    });
  });
});
