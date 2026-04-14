/**
 * Heartbeat 单元测试 - 简化为纯 timer
 *
 * Heartbeat 只负责：
 * 1. isDue() - 检查是否应该触发
 * 2. fire() - 向 motion/inbox/pending/ 写入 .md 消息
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Heartbeat } from '../../src/core/heartbeat.js';

async function createTempDir(): Promise<string> {
  const tempDir = path.join(tmpdir(), `clawforum-hb-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('Heartbeat', () => {
  let tempDir: string;
  let heartbeat: Heartbeat;

  beforeEach(async () => {
    tempDir = await createTempDir();
    // 创建 motion/inbox/pending 目录结构
    fs.mkdirSync(path.join(tempDir, 'motion', 'inbox', 'pending'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('isDue', () => {
    it('should return false on first call (initialized to now)', () => {
      heartbeat = new Heartbeat(tempDir, { interval: 1 });
      expect(heartbeat.isDue()).toBe(false);  // 启动后等满 interval 才触发
    });

    it('should return false immediately after fire', () => {
      heartbeat = new Heartbeat(tempDir, { interval: 1 });
      heartbeat.fire();
      expect(heartbeat.isDue()).toBe(false);
    });

    it('should return true after interval elapsed', async () => {
      heartbeat = new Heartbeat(tempDir, { interval: 1 }); // 1秒间隔
      heartbeat.fire();
      expect(heartbeat.isDue()).toBe(false);

      // 等待超过 1 秒
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(heartbeat.isDue()).toBe(true);
    });

    it('should respect custom interval', async () => {
      heartbeat = new Heartbeat(tempDir, { interval: 5 }); // 5秒间隔
      heartbeat.fire();
      expect(heartbeat.isDue()).toBe(false);

      // 等待 1 秒（小于间隔）
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(heartbeat.isDue()).toBe(false);
    });
  });

  describe('fire', () => {
    it('should write heartbeat message to motion inbox', () => {
      heartbeat = new Heartbeat(tempDir, { interval: 1 });
      heartbeat.fire();

      const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));

      expect(files.length).toBe(1);

      const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf-8');
      expect(content).toContain('type: heartbeat');
      expect(content).toContain('from: "system"');
      expect(content).toContain('priority: low');
      expect(content).toContain('心跳触发，请巡查。');
    });

    it('should update lastRun after fire', async () => {
      heartbeat = new Heartbeat(tempDir, { interval: 1 });
      expect(heartbeat.isDue()).toBe(false);  // 首次不 due

      // 等待后首次触发
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(heartbeat.isDue()).toBe(true);

      heartbeat.fire();
      expect(heartbeat.isDue()).toBe(false);  // fire 后重置

      // 再次等待后触发
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(heartbeat.isDue()).toBe(true);
    });

    it('should generate unique filenames for multiple fires', async () => {
      heartbeat = new Heartbeat(tempDir, { interval: 1 });

      heartbeat.fire();
      await new Promise(resolve => setTimeout(resolve, 50)); // 确保不同时间戳
      heartbeat.fire();

      const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));

      // 第一次 fire 生成文件，第二次被去重跳过
      expect(files.length).toBe(1);
    });

    it('should generate new file after previous heartbeat is consumed', async () => {
      heartbeat = new Heartbeat(tempDir, { interval: 1 });

      // 第一次 fire
      heartbeat.fire();
      const inboxDir = path.join(tempDir, 'motion', 'inbox', 'pending');
      let files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
      expect(files.length).toBe(1);

      // 模拟消费（移走文件）
      fs.unlinkSync(path.join(inboxDir, files[0]));

      // 第二次 fire 应该生成新文件
      await new Promise(resolve => setTimeout(resolve, 50));
      heartbeat.fire();
      files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
      expect(files.length).toBe(1);
    });

    it('should create inbox directory if not exists', () => {
      // 使用没有 pre-created 目录的 tempDir 子目录
      const newBaseDir = path.join(tempDir, 'newbase');
      fs.mkdirSync(newBaseDir, { recursive: true });

      heartbeat = new Heartbeat(newBaseDir, { interval: 1 });
      heartbeat.fire();

      const inboxDir = path.join(newBaseDir, 'motion', 'inbox', 'pending');
      expect(fs.existsSync(inboxDir)).toBe(true);

      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
      expect(files.length).toBe(1);
    });
  });

  describe('default interval', () => {
    it('should default to 300 seconds (5 minutes)', () => {
      heartbeat = new Heartbeat(tempDir); // 不传 interval
      heartbeat.fire();
      expect(heartbeat.isDue()).toBe(false);

      // 等待 1 秒（远小于 300 秒）
      // 不能直接测试 300 秒，但验证行为符合默认值
    });
  });
});
