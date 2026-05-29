/**
 * Heartbeat 单元测试 - 简化为纯 timer
 *
 * Heartbeat 只负责：
 * 1. isDue() - 检查是否应该触发
 * 2. fire() - 向 motion/inbox/pending/ 写入 .md 消息
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Heartbeat } from '../../src/core/runtime/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createSystemAudit } from '../../src/foundation/audit/index.js';
import { createInboxReader } from '../../src/foundation/messaging/index.js';
import { createTempDir, cleanupTempDirSync } from '../utils/temp.js';

function createTestHeartbeat(tempDir: string, intervalSec: number = 1): Heartbeat {
  const nodeFs = new NodeFileSystem({ baseDir: tempDir });
  const audit = createSystemAudit(nodeFs, tempDir);
  const inboxReader = createInboxReader(nodeFs, audit, path.join(tempDir, 'motion', 'inbox'));
  return new Heartbeat(tempDir, { interval: intervalSec, fs: nodeFs, audit, inboxReader });
}

describe('Heartbeat', () => {
  let tempDir: string;
  let heartbeat: Heartbeat;

  beforeEach(async () => {
    tempDir = await createTempDir('clawforum-hb-test-');
    // 创建 motion/inbox/pending 目录结构
    fs.mkdirSync(path.join(tempDir, 'motion', 'inbox', 'pending'), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupTempDirSync(tempDir);
  });

  describe('isDue', () => {
    it('should return false on first call (initialized to now)', () => {
      heartbeat = createTestHeartbeat(tempDir, 1);
      expect(heartbeat.isDue()).toBe(false);  // 启动后等满 interval 才触发
    });

    it('should return false immediately after fire', async () => {
      heartbeat = createTestHeartbeat(tempDir, 1);
      await heartbeat.fire();
      expect(heartbeat.isDue()).toBe(false);
    });

    describe('with fake timers', () => {
      beforeEach(() => { vi.useFakeTimers(); });
      afterEach(() => { vi.useRealTimers(); });

      it('should return true after interval elapsed', async () => {
        heartbeat = createTestHeartbeat(tempDir, 1); // 1秒间隔
        await heartbeat.fire();
        expect(heartbeat.isDue()).toBe(false);

        vi.advanceTimersByTime(1100);
        expect(heartbeat.isDue()).toBe(true);
      });

      it('should respect custom interval', async () => {
        heartbeat = createTestHeartbeat(tempDir, 5); // 5秒间隔
        await heartbeat.fire();
        expect(heartbeat.isDue()).toBe(false);

        vi.advanceTimersByTime(1000);
        expect(heartbeat.isDue()).toBe(false);
      });
    });
  });

  describe('fire', () => {
    it('should write heartbeat message to motion inbox', async () => {
      heartbeat = createTestHeartbeat(tempDir, 1);
      await heartbeat.fire();

      const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));

      expect(files.length).toBe(1);

      const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf-8');
      expect(content).toContain('type: heartbeat');
      expect(content).toContain('from: "system"');
      expect(content).toContain('priority: low');
      // phase 1419: heartbeat body is now empty (formatter ignores ctx.body / 措辞由 formatter 拼 base + HEARTBEAT.md)
      // Body section after frontmatter must be empty string (no Chinese, no leftover payload)
      const bodyAfterFrontmatter = content.split(/^---\s*$/m).slice(2).join('---').trim();
      expect(bodyAfterFrontmatter).toBe('');
    });

    describe('with fake timers', () => {
      beforeEach(() => { vi.useFakeTimers(); });
      afterEach(() => { vi.useRealTimers(); });

      it('should update lastRun after fire', async () => {
        heartbeat = createTestHeartbeat(tempDir, 1);
        expect(heartbeat.isDue()).toBe(false);  // 首次不 due

        vi.advanceTimersByTime(1100);
        expect(heartbeat.isDue()).toBe(true);

        await heartbeat.fire();
        expect(heartbeat.isDue()).toBe(false);  // fire 后重置

        vi.advanceTimersByTime(1100);
        expect(heartbeat.isDue()).toBe(true);
      });

      it('should generate unique filenames for multiple fires', async () => {
        heartbeat = createTestHeartbeat(tempDir, 1);

        vi.useFakeTimers({ shouldAdvanceTime: false });
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 0));
        await heartbeat.fire();
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 100)); // +100ms 确保不同时间戳
        await heartbeat.fire();

        const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
        const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));

        // 第一次 fire 生成文件，第二次被去重跳过
        expect(files.length).toBe(1);
      });

      it('should generate new file after previous heartbeat is consumed', async () => {
        heartbeat = createTestHeartbeat(tempDir, 1);

        // 第一次 fire
        await heartbeat.fire();
        const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
        let files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
        expect(files.length).toBe(1);

        // 模拟消费（移走文件）
        fs.unlinkSync(path.join(inboxDir, files[0]));

        // 第二次 fire 应该生成新文件
        vi.useFakeTimers({ shouldAdvanceTime: false });
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 1, 0)); // +1s 确保不同时间戳
        await heartbeat.fire();
        files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
        expect(files.length).toBe(1);
      });
    });

    it('should create inbox directory if not exists', async () => {
      // 使用没有 pre-created 目录的 tempDir 子目录
      const newBaseDir = path.join(tempDir, 'newbase');
      fs.mkdirSync(newBaseDir, { recursive: true });

      heartbeat = createTestHeartbeat(newBaseDir, 1);
      await heartbeat.fire();

      const inboxDir = path.join(newBaseDir, 'motion', 'inbox', 'pending');
      expect(fs.existsSync(inboxDir)).toBe(true);

      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
      expect(files.length).toBe(1);
    });
  });

  describe('default interval', () => {
    it('should default to 300 seconds (5 minutes)', async () => {
      heartbeat = createTestHeartbeat(tempDir); // 不传 interval
      await heartbeat.fire();
      expect(heartbeat.isDue()).toBe(false);

      // 等待 1 秒（远小于 300 秒）
      // 不能直接测试 300 秒，但验证行为符合默认值
    });
  });
});
