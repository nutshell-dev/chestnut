/**
 * Communication module tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { InboxReader } from '../../src/foundation/messaging/index.js';
import { OutboxWriter } from '../../src/core/communication/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import type { InboxMessage } from '../../src/types/contract.js';

async function createTempDir(): Promise<string> {
  const tempDir = path.join(tmpdir(), `clawforum-comm-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

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
${msg.contract_id ? `contract_id: ${msg.contract_id}` : ''}
---

${msg.content}
`;
}

describe('Communication', () => {
  describe('InboxReader', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let reader: InboxReader;

    beforeEach(async () => {
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
      await mockFs.ensureDir('inbox/pending');
      await mockFs.ensureDir('inbox/done');
      await mockFs.ensureDir('inbox/failed');
      reader = new InboxReader('inbox/pending', 'inbox/done', 'inbox/failed', mockFs);
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
      expect(doneFiles.length).toBe(1);
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
      expect(failedFiles.length).toBe(1);
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
  });

  describe('OutboxWriter', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let writer: OutboxWriter;

    beforeEach(async () => {
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
      writer = new OutboxWriter('test-claw', tempDir, mockFs);
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

      expect(filePath).toContain('outbox/pending');

      // Verify file exists and content
      // filePath is relative to fs baseDir, so read via mockFs
      const content = await mockFs.read(filePath);
      expect(content).toContain('Hello!');
      expect(content).toContain('RESPONSE');
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
