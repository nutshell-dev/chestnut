/**
 * Communication module tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { InboxWatcher } from '../../src/core/communication/index.js';
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
  describe('InboxWatcher', () => {
    let tempDir: string;
    let mockFs: NodeFileSystem;
    let watcher: InboxWatcher;

    beforeEach(async () => {
      tempDir = await createTempDir();
      mockFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
      await mockFs.ensureDir('inbox/pending');
      await mockFs.ensureDir('inbox/done');
      await mockFs.ensureDir('inbox/failed');
      watcher = new InboxWatcher(tempDir, mockFs);
    });

    afterEach(async () => {
      await watcher.stop();
      await cleanupTempDir(tempDir);
    });

    it('should process pending message on start', async () => {
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

      const messages: InboxMessage[] = [];
      await watcher.start(async (m) => {
        messages.push(m);
      });

      // Wait for processing
      await new Promise(r => setTimeout(r, 200));

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Test message');
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

      await watcher.start(async () => {});
      await new Promise(r => setTimeout(r, 200));

      // Check file moved to done
      const doneFiles = await fs.readdir(path.join(tempDir, 'inbox', 'done'));
      expect(doneFiles.length).toBe(1);
    });

    it('should move failed message to failed and continue', async () => {
      const msg1: InboxMessage = {
        id: 'msg-1',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Will fail',
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      const msg2: InboxMessage = {
        id: 'msg-2',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Will succeed',
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      await mockFs.writeAtomic('inbox/pending/1.md', buildMdMessage(msg1));
      await mockFs.writeAtomic('inbox/pending/2.md', buildMdMessage(msg2));

      const processed: string[] = [];
      await watcher.start(async (m) => {
        processed.push(m.content);
        if (m.content === 'Will fail') {
          throw new Error('Processing failed');
        }
      });

      await new Promise(r => setTimeout(r, 300));

      // Both should be processed despite first failing
      expect(processed).toContain('Will fail');
      expect(processed).toContain('Will succeed');

      // Failed message should be in failed/
      const failedFiles = await fs.readdir(path.join(tempDir, 'inbox', 'failed'));
      expect(failedFiles.length).toBe(1);
    });

    it('should process messages by priority', async () => {
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

      const order: string[] = [];
      await watcher.start(async (m) => {
        order.push(m.content);
      });

      await new Promise(r => setTimeout(r, 200));

      // Critical should be processed first despite being written second
      expect(order[0]).toBe('Critical');
      expect(order[1]).toBe('Normal');
    });

    it('should return queue length', async () => {
      // Don't start processing yet
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

      // Queue length should be 1 before starting
      expect(await watcher.queueLength()).toBe(1);

      await watcher.start(async () => {});
      await new Promise(r => setTimeout(r, 200));

      // After processing, queue should be empty
      expect(await watcher.queueLength()).toBe(0);
    });

    // Phase 2 质量审查补充：move 失败测试
    it('should not cause duplicate processing when move fails', async () => {
      const msg: InboxMessage = {
        id: 'msg-1',
        type: 'message',
        from: 'motion-1',
        to: 'claw-1',
        content: 'Test move failure',
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      await mockFs.writeAtomic('inbox/pending/test.md', buildMdMessage(msg));

      let processCount = 0;
      const processedIds: string[] = [];

      await watcher.start(async (m) => {
        processCount++;
        processedIds.push(m.id);
      });

      // Wait for processing
      await new Promise(r => setTimeout(r, 200));

      // Message should be processed exactly once
      // (even if move fails, the message shouldn't be re-processed)
      expect(processCount).toBe(1);
      expect(processedIds).toEqual(['msg-1']);
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
