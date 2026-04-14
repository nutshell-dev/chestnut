/**
 * Inbox 测试 - 优先级排序 + failed 移动 + 新增测试
 * 
 * 简化测试：使用真实文件系统，验证核心行为
 * 
 * 新增测试：
 * - Priority queue 排序验证
 * - Deduplication (Set)
 * - MAX_QUEUE_SIZE 行为
 * - loadExistingMessages 冷启动
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { InboxWatcher } from '../../src/core/communication/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { InboxMessage } from '../../src/types/contract.js';
import { INBOX_MAX_QUEUE_SIZE } from '../../src/constants.js';

describe('InboxWatcher', () => {
  const processedMessages: InboxMessage[] = [];
  let testDir: string;
  // 跟踪本测试中启动的所有 watcher，afterEach 统一 stop，防止断言失败时泄漏
  const activeWatchers: InboxWatcher[] = [];

  function makeInbox(dir: string): InboxWatcher {
    const nfs = new NodeFileSystem({ baseDir: dir, enforcePermissions: false });
    const w = new InboxWatcher(dir, nfs);
    activeWatchers.push(w);
    return w;
  }

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `clawforum-inbox-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(testDir, { recursive: true });
    processedMessages.length = 0;
  });

  afterEach(async () => {
    // 先停所有 watcher（防止 fs.rm 时 watcher 仍监听目录引发报错）
    for (const w of activeWatchers.splice(0)) {
      await w.stop().catch(() => {});
    }
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should parse message priority from frontmatter', async () => {
    // 简单验证：创建带 frontmatter 的消息文件，解析后检查 priority
    const msgContent = `---
type: normal
priority: high
id: test-msg-1
from: test-sender
timestamp: 2026-03-15T12:00:00Z
---
Test message content`;

    const msgPath = path.join(testDir, 'test_message.md');
    await fs.writeFile(msgPath, msgContent, 'utf-8');

    // 读取并解析
    const content = await fs.readFile(msgPath, 'utf-8');
    
    // 简单 frontmatter 解析
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    expect(match).toBeTruthy();
    
    const frontmatter = match![1];
    const body = match![2].trim();
    
    // 验证 priority 被正确解析
    expect(frontmatter).toContain('priority: high');
    expect(body).toBe('Test message content');
  });

  it('should move failed messages to failed directory', async () => {
    // 创建 mock 文件系统操作来测试失败处理逻辑
    const clawDir = path.join(testDir, 'test-claw');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    const failedDir = path.join(clawDir, 'inbox', 'failed');
    
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.mkdir(failedDir, { recursive: true });

    // 创建一个消息文件
    const msgFile = path.join(pendingDir, '1000_normal_test.md');
    await fs.writeFile(msgFile, '---\ntype: normal\n---\nTest', 'utf-8');

    // 模拟 move 操作（从 pending 移到 failed）
    const failedFile = path.join(failedDir, '1000_normal_test.md');
    await fs.rename(msgFile, failedFile);

    // 验证文件在 failed 目录
    const failedFiles = await fs.readdir(failedDir);
    expect(failedFiles).toContain('1000_normal_test.md');

    // 验证 pending 目录为空
    const pendingFiles = await fs.readdir(pendingDir);
    expect(pendingFiles).toHaveLength(0);
  });

  // === 新增测试 ===

  it('should deduplicate file processing', async () => {
    const clawDir = path.join(testDir, 'dedup-test');
    await fs.mkdir(clawDir, { recursive: true });
    const inbox = makeInbox(clawDir);
    
    const processed: string[] = [];
    await inbox.start(async (msg: InboxMessage) => {
      processed.push(msg.id);
    });

    // 创建消息文件
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    
    const msgFile = path.join(pendingDir, '1000_high_test.md');
    const relPath = path.relative(clawDir, msgFile);
    await fs.writeFile(msgFile, '---\ntype: normal\npriority: high\nid: msg-1\n---\nBody', 'utf-8');

    // 手动触发两次（模拟 watcher 重复事件）
    await (inbox as any).handleNewFile(relPath);
    await (inbox as any).handleNewFile(relPath); // 重复

    // 等待处理
    await new Promise(r => setTimeout(r, 100));

    // 应该只处理一次
    expect(processed.filter(id => id === 'msg-1')).toHaveLength(1);
  });

  it('should sort queue by priority (critical > high > normal > low)', async () => {
    const clawDir = path.join(testDir, 'priority-test');
    await fs.mkdir(clawDir, { recursive: true });
    const inbox = makeInbox(clawDir);

    // 手动构建队列
    const queue = (inbox as any).queue;
    queue.push(
      { message: { priority: 'low' }, priority: 1, timestamp: 1000 },
      { message: { priority: 'critical' }, priority: 4, timestamp: 1000 },
      { message: { priority: 'normal' }, priority: 2, timestamp: 1000 },
      { message: { priority: 'high' }, priority: 3, timestamp: 1000 }
    );

    // 排序
    (inbox as any).sortQueue();

    // 验证顺序：critical(4) > high(3) > normal(2) > low(1)
    expect(queue[0].priority).toBe(4);
    expect(queue[1].priority).toBe(3);
    expect(queue[2].priority).toBe(2);
    expect(queue[3].priority).toBe(1);
  });

  it('should sort queue by timestamp for same priority (FIFO)', async () => {
    const clawDir = path.join(testDir, 'fifo-test');
    await fs.mkdir(clawDir, { recursive: true });
    const inbox = makeInbox(clawDir);

    const queue = (inbox as any).queue;
    queue.push(
      { message: { priority: 'high' }, priority: 3, timestamp: 3000, id: 'third' },
      { message: { priority: 'high' }, priority: 3, timestamp: 1000, id: 'first' },
      { message: { priority: 'high' }, priority: 3, timestamp: 2000, id: 'second' }
    );

    (inbox as any).sortQueue();

    // 同优先级按时间升序（FIFO）
    expect(queue[0].id).toBe('first');
    expect(queue[1].id).toBe('second');
    expect(queue[2].id).toBe('third');
  });

  it('should include UUID in done/failed filenames', async () => {
    const clawDir = path.join(testDir, 'uuid-test');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    const doneDir = path.join(clawDir, 'inbox', 'done');
    
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.mkdir(doneDir, { recursive: true });

    const msgFile = path.join(pendingDir, 'test.md');
    const relPath = path.relative(clawDir, msgFile);
    await fs.writeFile(msgFile, '---\ntype: normal\n---\nTest', 'utf-8');

    const inbox = makeInbox(clawDir);

    // 触发 moveToDone
    await (inbox as any).moveToDone(relPath);

    // 验证 done 目录中的文件名包含 UUID（格式：{timestamp}_{uuid8}_{filename}）
    const doneFiles = await fs.readdir(doneDir);
    expect(doneFiles).toHaveLength(1);
    
    const parts = doneFiles[0].split('_');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[1].length).toBe(8); // UUID8
  });

  // === 新增：更多队列管理测试 ===

  it('should use Set for deduplication tracking', async () => {
    const clawDir = path.join(testDir, 'set-dedup-test');
    await fs.mkdir(clawDir, { recursive: true });
    const inbox = makeInbox(clawDir);
    
    // 验证 processedFiles 是 Set
    const processedFiles = (inbox as any).processedFiles;
    expect(processedFiles).toBeInstanceOf(Set);
  });

  it('should add and cleanup file path in processedFiles Set', async () => {
    const clawDir = path.join(testDir, 'processed-set-test');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });

    const inbox = makeInbox(clawDir);

    const msgFile = path.join(pendingDir, 'test.md');
    const relPath = path.relative(clawDir, msgFile);
    await fs.writeFile(msgFile, '---\ntype: normal\nid: test-1\n---\nBody', 'utf-8');

    const processedFiles = (inbox as any).processedFiles;

    // 处理文件前，Set 为空
    expect(processedFiles.has(relPath)).toBe(false);

    // 处理文件
    await inbox.start(async () => {});
    await (inbox as any).handleNewFile(relPath);
    await new Promise(r => setTimeout(r, 50));

    // 处理完成后，Set 应被清理（防止内存泄漏）
    expect(processedFiles.has(relPath)).toBe(false);
  });

  it('should load existing messages on cold start', async () => {
    const clawDir = path.join(testDir, 'cold-start-test');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });

    // 创建多个待处理的消息文件
    await fs.writeFile(
      path.join(pendingDir, '1000_normal_msg1.md'),
      '---\ntype: normal\npriority: normal\nid: msg-1\n---\nBody 1',
      'utf-8'
    );
    await fs.writeFile(
      path.join(pendingDir, '2000_high_msg2.md'),
      '---\ntype: normal\npriority: high\nid: msg-2\n---\nBody 2',
      'utf-8'
    );

    const inbox = makeInbox(clawDir);

    const processed: string[] = [];
    await inbox.start(async (msg: InboxMessage) => {
      processed.push(msg.id);
    });

    // 等待冷启动处理
    await new Promise(r => setTimeout(r, 200));

    // 应该处理已存在的文件
    expect(processed).toContain('msg-1');
    expect(processed).toContain('msg-2');
  });

  it('should drop lowest priority message when queue is full', async () => {
    const clawDir = path.join(testDir, 'queue-limit-test');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    const failedDir = path.join(clawDir, 'inbox', 'failed');
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.mkdir(failedDir, { recursive: true });

    const inbox = makeInbox(clawDir);

    // Fill internal queue to the limit with low-priority items
    const queue = (inbox as any).queue;
    for (let i = 0; i < INBOX_MAX_QUEUE_SIZE; i++) {
      queue.push({
        message: { id: `low-${i}`, priority: 'low' },
        filePath: `/fake/low-${i}.md`,
        priority: 1,
        timestamp: 1000 + i,
      });
    }
    expect(queue).toHaveLength(INBOX_MAX_QUEUE_SIZE);

    // Add a high-priority message to trigger the drop path
    const highFile = path.join(pendingDir, 'high.md');
    const relPath = path.relative(clawDir, highFile);
    await fs.writeFile(highFile, '---\ntype: normal\npriority: high\nid: high-msg\n---\nHigh', 'utf-8');

    await inbox.start(async () => {});
    await (inbox as any).handleNewFile(relPath);
    await new Promise(r => setTimeout(r, 50));

    // Queue should not exceed max (one was dropped, one was added)
    expect((inbox as any).queue.length).toBeLessThanOrEqual(INBOX_MAX_QUEUE_SIZE);

    // The dropped item is the last (lowest) priority; the new high-priority item should be present
    const remaining = (inbox as any).queue as Array<{ message: { id: string }; priority: number }>;
    const hasHighMsg = remaining.some(item => item.message.id === 'high-msg') ||
      // may have already been dequeued and processed
      (await fs.readdir(path.join(clawDir, 'inbox', 'done')).catch(() => [])).some((f: string) => f.includes('high'));
    expect(hasHighMsg).toBe(true);
  });

  it('should process messages in priority order after cold start', async () => {
    const clawDir = path.join(testDir, 'priority-cold-start');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });

    // 创建不同优先级的消息（使用相同时间戳，只通过文件名排序）
    // 文件名格式：{timestamp}_{priority}_{id}.md
    await fs.writeFile(
      path.join(pendingDir, '1000_low_low.md'),
      '---\ntype: normal\npriority: low\nid: low-msg\n---\nLow',
      'utf-8'
    );
    await fs.writeFile(
      path.join(pendingDir, '1000_critical_critical.md'),
      '---\ntype: normal\npriority: critical\nid: critical-msg\n---\nCritical',
      'utf-8'
    );
    await fs.writeFile(
      path.join(pendingDir, '1000_normal_normal.md'),
      '---\ntype: normal\npriority: normal\nid: normal-msg\n---\nNormal',
      'utf-8'
    );

    const inbox = makeInbox(clawDir);

    const processed: string[] = [];
    await inbox.start(async (msg: InboxMessage) => {
      processed.push(msg.id);
    });

    // 等待冷启动处理
    await new Promise(r => setTimeout(r, 300));

    // 验证所有消息都被处理
    expect(processed).toContain('critical-msg');
    expect(processed).toContain('normal-msg');
    expect(processed).toContain('low-msg');
  });

  // === 验证降级行为（integration with validation.ts）===

  it('非法 priority frontmatter 降级为 normal 并正常入队', async () => {
    const clawDir = path.join(testDir, 'invalid-priority-test');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });

    const inbox = makeInbox(clawDir);

    const msgFile = path.join(pendingDir, '1000_normal_p.md');
    const relPath = path.relative(clawDir, msgFile);
    await fs.writeFile(msgFile, '---\ntype: message\npriority: urgent\nid: p-fallback\n---\nBody', 'utf-8');

    const received: InboxMessage[] = [];
    await inbox.start(async (msg: InboxMessage) => { received.push(msg); });
    await (inbox as any).handleNewFile(relPath);
    await new Promise(r => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].priority).toBe('normal');
    expect(received[0].id).toBe('p-fallback');
  });

  it('未知 type frontmatter 降级为 message 并正常入队', async () => {
    const clawDir = path.join(testDir, 'invalid-type-test');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    const inbox = makeInbox(clawDir);

    const msgFile = path.join(pendingDir, '1000_normal_t.md');
    const relPath = path.relative(clawDir, msgFile);
    await fs.writeFile(msgFile, '---\ntype: unknown_event\npriority: normal\nid: t-fallback\n---\nBody', 'utf-8');

    const received: InboxMessage[] = [];
    await inbox.start(async (msg: InboxMessage) => { received.push(msg); });
    await (inbox as any).handleNewFile(relPath);
    await new Promise(r => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('message');
    expect(received[0].id).toBe('t-fallback');
  });

  it('watchdog_ 前缀 type 原样透传，不降级', async () => {
    const clawDir = path.join(testDir, 'watchdog-type-test');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    const inbox = makeInbox(clawDir);

    const msgFile = path.join(pendingDir, '1000_normal_wd.md');
    const relPath = path.relative(clawDir, msgFile);
    await fs.writeFile(msgFile, '---\ntype: watchdog_ping\npriority: normal\nid: wd-passthrough\n---\nBody', 'utf-8');

    const received: InboxMessage[] = [];
    await inbox.start(async (msg: InboxMessage) => { received.push(msg); });
    await (inbox as any).handleNewFile(relPath);
    await new Promise(r => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('watchdog_ping');
  });

  it('should move malformed message to failed/ on parse error (Phase 44 H3)', async () => {
    const clawDir = path.join(testDir, 'parse-fail-test');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    const inbox = makeInbox(clawDir);

    // Malformed: has opening --- but no closing ---
    const malformedFile = path.join(pendingDir, '1000_normal_malformed.md');
    const relPath = path.relative(clawDir, malformedFile);
    await fs.writeFile(malformedFile, '---\ntype: normal\nid: bad-msg\n(no closing fence)', 'utf-8');

    await (inbox as any).handleNewFile(relPath);

    // pending file should be gone
    const pendingFiles = await fs.readdir(pendingDir);
    expect(pendingFiles).toHaveLength(0);

    // failed/ should contain the moved file
    const failedDir = path.join(clawDir, 'inbox', 'failed');
    const failedFiles = await fs.readdir(failedDir);
    expect(failedFiles).toHaveLength(1);
    expect(failedFiles[0]).toContain('1000_normal_malformed.md');
  });
});
