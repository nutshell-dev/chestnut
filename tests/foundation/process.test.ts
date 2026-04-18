/**
 * ProcessManager 单元测试
 *
 * 测试可隔离的纯逻辑单元（不涉及真实子进程启动）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

async function createTempDir(): Promise<string> {
  const tempDir = path.join(tmpdir(), `clawforum-process-test-${randomUUID()}`);
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

describe('ProcessManager', () => {
  let tempDir: string;
  let fsInstance: NodeFileSystem;
  let processManager: ProcessManager;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fsInstance = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
    processManager = new ProcessManager(fsInstance, tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('isAlive', () => {
    it('should return false when pid file does not exist', () => {
      const result = processManager.isAlive('nonexistent-claw');
      expect(result).toBe(false);
    });

    it('should return false when pid file contains invalid content', () => {
      // 创建 pid 文件但内容不是有效数字
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), 'not-a-number');

      const result = processManager.isAlive('test-claw');
      expect(result).toBe(false);
    });

    it('should return false when pid file contains empty content', () => {
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), '');

      const result = processManager.isAlive('test-claw');
      expect(result).toBe(false);
    });

    it('should return false when pid file contains whitespace only', () => {
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), '   \n  ');

      const result = processManager.isAlive('test-claw');
      expect(result).toBe(false);
    });
  });

  describe('stop', () => {
    it('should return false when pid file does not exist', async () => {
      const result = await processManager.stop('nonexistent-claw');
      expect(result).toBe(false);
    });

    it('should clean up stale pid file after detecting dead process', async () => {
      // 创建一个指向不存在进程的 pid 文件
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      const pidFile = path.join(statusDir, 'pid');
      
      // 使用一个不可能存在的 PID（Linux 的 PID 上限通常是 2^22，macOS 更低）
      const fakePid = 999999;
      fs.writeFileSync(pidFile, String(fakePid));

      // isAlive 应该返回 false（因为进程不存在）
      expect(processManager.isAlive('test-claw')).toBe(false);

      // 等待 isAlive 触发的异步清理完成
      await new Promise(resolve => setTimeout(resolve, 100));

      // pid 文件应该被 isAlive 清理
      expect(fs.existsSync(pidFile)).toBe(false);
    });

    it('should return true when stopping already-cleaned process', async () => {
      // 创建一个指向不存在进程的 pid 文件
      const statusDir = path.join(tempDir, 'claws', 'test-claw-2', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      const pidFile = path.join(statusDir, 'pid');
      
      const fakePid = 999998;
      fs.writeFileSync(pidFile, String(fakePid));

      // 直接调用 stop（不先调用 isAlive）
      // stop 应该检测到进程不存在，清理 pid 文件，返回 true
      const result = await processManager.stop('test-claw-2');
      expect(result).toBe(true);
      
      // pid 文件应该被清理
      expect(fs.existsSync(pidFile)).toBe(false);
    });
  });

  describe('dirResolver', () => {
    it('should use default path (claws/{id}) when no resolver provided', () => {
      // 使用默认构造函数（已在 beforeEach 中创建）
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), '12345');

      // isAlive 应该读取 claws/test-claw/status/pid
      const result = processManager.isAlive('test-claw');
      // 12345 进程大概率不存在，返回 false
      expect(result).toBe(false);
    });

    it('should use custom resolver for motion path', () => {
      // 创建带自定义 resolver 的 PM
      const motionPM = new ProcessManager(fsInstance, tempDir, (id) => {
        if (id === 'motion') return path.join(tempDir, 'motion');
        return path.join(tempDir, 'claws', id);
      });

      // 在 motion/status/pid 创建文件
      const motionStatusDir = path.join(tempDir, 'motion', 'status');
      fs.mkdirSync(motionStatusDir, { recursive: true });
      fs.writeFileSync(path.join(motionStatusDir, 'pid'), '12345');

      // isAlive 应该读取 motion/status/pid
      const result = motionPM.isAlive('motion');
      expect(result).toBe(false);
    });

    it('should use custom resolver for regular claw when using motion resolver', () => {
      // 创建带自定义 resolver 的 PM（motion 风格）
      const motionPM = new ProcessManager(fsInstance, tempDir, (id) => {
        if (id === 'motion') return path.join(tempDir, 'motion');
        return path.join(tempDir, 'claws', id);
      });

      // 在 claws/test-claw/status/pid 创建文件
      const clawStatusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(clawStatusDir, { recursive: true });
      fs.writeFileSync(path.join(clawStatusDir, 'pid'), '12345');

      // isAlive 应该正确解析到 claws/test-claw
      const result = motionPM.isAlive('test-claw');
      expect(result).toBe(false);
    });
  });

  describe('getAliveStatus edge cases', () => {
    it('空 PID 文件返回 alive:false，reason 含 "empty"', () => {
      const statusDir = path.join(tempDir, 'claws', 'empty-pid-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), '   ');  // 空白

      const result = processManager.getAliveStatus('empty-pid-claw');
      expect(result.alive).toBe(false);
      expect(result.reason).toMatch(/empty/i);
    });

    it('PID 文件内容非数字返回 alive:false，reason 含 "invalid"', () => {
      const statusDir = path.join(tempDir, 'claws', 'bad-pid-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), 'not-a-number');

      const result = processManager.getAliveStatus('bad-pid-claw');
      expect(result.alive).toBe(false);
      expect(result.reason).toMatch(/invalid/i);
    });

    it('PID 文件不存在返回 alive:false，reason 含 "no PID file"', () => {
      const result = processManager.getAliveStatus('no-pid-file-claw');
      expect(result.alive).toBe(false);
      expect(result.reason).toMatch(/no PID file/i);
    });
  });

  describe('isAlive with live process', () => {
    it('should return true when pid file points to current process', () => {
      // 使用当前进程 PID（肯定存在）
      const statusDir = path.join(tempDir, 'claws', 'live-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), String(process.pid));

      const result = processManager.isAlive('live-claw');
      expect(result).toBe(true);
    });
  });

  describe('spawn', () => {
    it('should throw error when pid file already exists and process is alive', async () => {
      // 预先创建 PID 文件，使用真实运行的进程 PID
      const statusDir = path.join(tempDir, 'claws', 'existing-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), String(process.pid));

      // spawn 应该抛出 already running 错误
      await expect(
        processManager.spawn('existing-claw', {
          command: 'node',
          args: ['/fake/daemon-entry.js', 'existing-claw'],
          logFile: path.join(tempDir, 'claws', 'existing-claw', 'logs', 'daemon.log'),
          env: { ...process.env },
        })
      ).rejects.toThrow(/already running/);
    });

    it('should throw error with correct message when process is alive', async () => {
      const statusDir = path.join(tempDir, 'claws', 'busy-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      // 使用真实运行的进程 PID
      fs.writeFileSync(path.join(statusDir, 'pid'), String(process.pid));

      try {
        await processManager.spawn('busy-claw', {
          command: 'node',
          args: ['/fake/daemon-entry.js', 'busy-claw'],
          logFile: path.join(tempDir, 'claws', 'busy-claw', 'logs', 'daemon.log'),
          env: { ...process.env },
        });
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('busy-claw');
        expect(err.message).toContain('already running');
      }
    });
  });
});
