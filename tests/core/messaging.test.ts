/**
 * Messaging module tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { InboxReader } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { OutboxWriter } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { makeAudit } from '../helpers/audit.js';
import type { InboxMessage } from '../../src/foundation/messaging/types.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, OUTBOX_PENDING_DIR } from '../../src/foundation/messaging/dirs.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

/**
 * Build YAML frontmatter message for testing (MVP aligned)
 */
function buildMdMessage(msg: InboxMessage): string {
  return `---
id: ${msg.id}
type: ${msg.type}
from: ${msg.from}
to: ${msg.to}
priority: ${msg.priority}
timestamp: ${msg.timestamp}
${msg.metadata?.contract_id ? `contract_id: ${msg.metadata.contract_id}` : ''}
---

${msg.content}
`;
}

describe('Messaging', () => {
  describe('InboxReader', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let reader: InboxReader;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(async () => {
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir });
      await mockFs.ensureDir(INBOX_PENDING_DIR);
      await mockFs.ensureDir(INBOX_DONE_DIR);
      await mockFs.ensureDir(INBOX_FAILED_DIR);
      const { audit, events } = makeAudit();
      auditEvents = events;
      reader = new InboxReader(INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, mockFs, audit);
      await reader.init();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('should process pending messages on drainInbox', async () => {
      const msg: InboxMessage = {
        id: 'msg-1',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Test message',
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      await mockFs.writeAtomic('inbox/pending/test.md', buildMdMessage(msg));

      const entries = await reader.drainInbox();

      expect(entries).toHaveLength(1);
      expect(entries[0].message.content).toBe('Test message');
    });

    it('should move processed message to done', async () => {
      const msg: InboxMessage = {
        id: 'msg-1',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Test',
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      await mockFs.writeAtomic('inbox/pending/test.md', buildMdMessage(msg));

      const entries = await reader.drainInbox();
      await reader.markDone(entries[0].filePath);

      // Check file moved to done
      const doneFiles = await fs.readdir(path.join(tempDir, 'inbox', 'done'));
      expect(doneFiles).toHaveLength(1);
      expect(doneFiles[0]).toMatch(/^\d+_[a-f0-9]{8}_test\.md$/);
    });

    it('should move failed message to failed', async () => {
      const msg: InboxMessage = {
        id: 'msg-1',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Test',
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      await mockFs.writeAtomic('inbox/pending/test.md', buildMdMessage(msg));

      const entries = await reader.drainInbox();
      await reader.markFailed(entries[0].filePath);

      // Failed message should be in failed/
      const failedFiles = await fs.readdir(path.join(tempDir, 'inbox', 'failed'));
      expect(failedFiles).toHaveLength(1);
      expect(failedFiles[0]).toMatch(/^\d+_[a-f0-9]{8}_test\.md$/);
    });

    it('should return messages by priority', async () => {
      const normalMsg: InboxMessage = {
        id: 'normal',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Normal',
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      const criticalMsg: InboxMessage = {
        id: 'critical',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Critical',
        priority: 'critical',
        timestamp: new Date().toISOString(),
      };

      // Write normal first, then critical
      await mockFs.writeAtomic('inbox/pending/normal.md', buildMdMessage(normalMsg));
      await mockFs.writeAtomic('inbox/pending/critical.md', buildMdMessage(criticalMsg));

      const entries = await reader.drainInbox();

      // Critical should be first despite being written second
      expect(entries[0].message.content).toBe('Critical');
      expect(entries[1].message.content).toBe('Normal');
    });

    it('should include UUID in done/failed filenames', async () => {
      const msg: InboxMessage = {
        id: 'msg-1',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Test',
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      await mockFs.writeAtomic('inbox/pending/test.md', buildMdMessage(msg));

      const entries = await reader.drainInbox();
      await reader.markDone(entries[0].filePath);

      // Verify done filename contains UUID (format: {timestamp}_{uuid8}_{filename})
      const doneFiles = await fs.readdir(path.join(tempDir, 'inbox', 'done'));
      expect(doneFiles).toHaveLength(1);
      const parts = doneFiles[0].split('_');
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts[1].length).toBe(8); // UUID8
    });

    it('should move malformed message to failed on parse error', async () => {
      // Malformed: has opening --- but no closing ---
      await mockFs.writeAtomic(
        'inbox/pending/malformed.md',
        '---\ntype: normal\nid: bad-msg\n(no closing fence)',
      );

      const entries = await reader.drainInbox();

      // No valid entries returned
      expect(entries).toHaveLength(0);

      // failed/ should contain the moved file
      const failedFiles = await fs.readdir(path.join(tempDir, 'inbox', 'failed'));
      expect(failedFiles.length).toBe(1);
      expect(failedFiles[0]).toContain('malformed.md');
    });

    describe('peekMetas', () => {
      it('returns all meta entries when no filter', async () => {
        const msg1: InboxMessage = { id: 'msg-1', type: 'message', from: 'a', to: 'b', content: 'Low', priority: 'low', timestamp: new Date().toISOString() };
        const msg2: InboxMessage = { id: 'msg-2', type: 'message', from: 'a', to: 'b', content: 'High', priority: 'high', timestamp: new Date().toISOString() };
        await mockFs.writeAtomic('inbox/pending/low.md', buildMdMessage(msg1));
        await mockFs.writeAtomic('inbox/pending/high.md', buildMdMessage(msg2));

        const metas = await reader.peekMetas();
        expect(metas).toHaveLength(2);
      });

      it('filters by priority', async () => {
        const msg1: InboxMessage = { id: 'msg-1', type: 'message', from: 'a', to: 'b', content: 'Low', priority: 'low', timestamp: new Date().toISOString() };
        const msg2: InboxMessage = { id: 'msg-2', type: 'message', from: 'a', to: 'b', content: 'High', priority: 'high', timestamp: new Date().toISOString() };
        await mockFs.writeAtomic('inbox/pending/low.md', buildMdMessage(msg1));
        await mockFs.writeAtomic('inbox/pending/high.md', buildMdMessage(msg2));

        const metas = await reader.peekMetas({ priority: ['high', 'critical'] });
        expect(metas).toHaveLength(1);
        expect(metas[0].priority).toBe('high');
      });

      it('returns empty array when no matching priority', async () => {
        const msg1: InboxMessage = { id: 'msg-1', type: 'message', from: 'a', to: 'b', content: 'Low', priority: 'low', timestamp: new Date().toISOString() };
        await mockFs.writeAtomic('inbox/pending/low.md', buildMdMessage(msg1));

        const metas = await reader.peekMetas({ priority: ['critical'] });
        expect(metas).toHaveLength(0);
      });

      it('returns empty array when pendingDir does not exist', async () => {
        const nonExistentPending = path.join(tempDir, 'nonexistent', 'pending');
        const freshReader = new InboxReader(nonExistentPending, INBOX_DONE_DIR, INBOX_FAILED_DIR, mockFs, makeAudit().audit);
        const metas = await freshReader.peekMetas();
        expect(metas).toEqual([]);
      });

      it('does not consume files (non-destructive)', async () => {
        const msg: InboxMessage = { id: 'msg-1', type: 'message', from: 'a', to: 'b', content: 'Test', priority: 'normal', timestamp: new Date().toISOString() };
        await mockFs.writeAtomic('inbox/pending/test.md', buildMdMessage(msg));

        const beforeFiles = await fs.readdir(path.join(tempDir, 'inbox', 'pending'));
        await reader.peekMetas();
        const afterFiles = await fs.readdir(path.join(tempDir, 'inbox', 'pending'));
        expect(afterFiles).toEqual(beforeFiles);
      });

      it('skips malformed files + audit INBOX_META_FAILED', async () => {
        await mockFs.writeAtomic('inbox/pending/bad.md', '---\nthis is not valid frontmatter');

        const metas = await reader.peekMetas();
        expect(metas).toHaveLength(0);
        expect(auditEvents).toEqual(
          expect.arrayContaining([
            expect.arrayContaining(['inbox_meta_failed', 'file=bad.md', 'kind=parse_failed']),
          ]),
        );
      });

      it('audit on list failure (non-ENOENT) + returns empty', async () => {
        const throwingFs = {
          ...mockFs,
          list: vi.fn().mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' })),
        } as unknown as NodeFileSystem;
        const { audit, events } = makeAudit();
        const throwingReader = new InboxReader(INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, throwingFs, audit);

        const metas = await throwingReader.peekMetas();
        expect(metas).toEqual([]);
        const listFailEvent = events.find(e => e[0] === 'inbox_list_failed');
        expect(listFailEvent).toBeDefined();
        expect(listFailEvent).toEqual(
          expect.arrayContaining(['inbox_list_failed', 'op=peek', 'error_code=EACCES']),
        );
        expect(listFailEvent!.some((col: string) => col.startsWith('reason=Permission denied'))).toBe(true);
      });
    });
  });

  describe('OutboxWriter', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let writer: OutboxWriter;

    beforeEach(async () => {
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir });
      writer = createOutboxWriter('test-claw', tempDir, mockFs, makeAudit().audit);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('should write message to outbox', async () => {
      const filePath = await writer.write({
        type: 'response',
        to: 'motion-1',
        content: 'Hello!',
      });

      expect(filePath).toContain(OUTBOX_PENDING_DIR);

      // Verify file exists and content
      // filePath is relative to fs baseDir, so read via mockFs
      const content = await mockFs.read(filePath);
      expect(content).toContain('Hello!');
      expect(content).toContain('type: response');
    });

    it('should include all message fields', async () => {
      await writer.write({
        type: 'status_report',
        to: 'motion-1',
        content: 'Task complete',
      });

      const outboxDir = path.join(tempDir, 'outbox', 'pending');
      const files = await fs.readdir(outboxDir);
      expect(files.length).toBe(1);
      expect(files[0]).toContain('status_report');
    });
  });
});
