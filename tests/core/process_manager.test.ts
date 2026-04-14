/**
 * ProcessManager 测试 - 进程管理核心逻辑
 *
 * 测试通过 public API 进行，不直接调用 private 方法
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

async function createTempDir(): Promise<string> {
  const tempDir = path.join(tmpdir(), `pm-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

describe('ProcessManager', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('dirResolver - 默认路径', () => {
    it('should use claws/{id}/status/pid as default path', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const pidFile = path.join(tempDir, 'claws', 'test-claw', 'status', 'pid');

      // 写入 PID 文件
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, process.pid.toString(), 'utf-8');

      expect(pm.isAlive('test-claw')).toBe(true);
    });

    it('should return false when PID file does not exist', () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      expect(pm.isAlive('nonexistent')).toBe(false);
    });
  });

  describe('dirResolver - 自定义路径', () => {
    it('should use custom resolver for motion path', async () => {
      const pm = new ProcessManager(nodeFs, tempDir, (id) => {
        if (id === 'motion') return path.join(tempDir, 'motion');
        return path.join(tempDir, 'claws', id);
      });

      // motion PID 文件在 motion/status/pid
      const motionPidFile = path.join(tempDir, 'motion', 'status', 'pid');
      await fs.mkdir(path.dirname(motionPidFile), { recursive: true });
      await fs.writeFile(motionPidFile, process.pid.toString(), 'utf-8');

      // claw PID 文件在 claws/{id}/status/pid
      const clawPidFile = path.join(tempDir, 'claws', 'test-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(clawPidFile), { recursive: true });
      await fs.writeFile(clawPidFile, '999999', 'utf-8');

      expect(pm.isAlive('motion')).toBe(true);
      expect(pm.isAlive('test-claw')).toBe(false); // 死进程
    });
  });

  describe('isAlive - 进程检测', () => {
    it('should return true for current process PID', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const pidFile = path.join(tempDir, 'claws', 'live-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, process.pid.toString(), 'utf-8');

      expect(pm.isAlive('live-claw')).toBe(true);
    });

    it('should return false and clean stale PID for dead process', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const pidFile = path.join(tempDir, 'claws', 'dead-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, '999999', 'utf-8'); // 不存在的进程

      expect(pm.isAlive('dead-claw')).toBe(false);

      // 等待异步清理完成
      await new Promise(resolve => setTimeout(resolve, 100));

      // PID 文件应被清理
      expect(fsSync.existsSync(pidFile)).toBe(false);
    });

    it('should return false for invalid PID content', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const pidFile = path.join(tempDir, 'claws', 'invalid-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, 'not-a-number', 'utf-8');

      expect(pm.isAlive('invalid-claw')).toBe(false);
    });
  });

  describe('stop - 停止进程', () => {
    it('should return false when PID file does not exist', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const result = await pm.stop('nonexistent');
      expect(result).toBe(false);
    });

    it('should return true and clean stale PID for dead process', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const pidFile = path.join(tempDir, 'claws', 'stale-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, '999998', 'utf-8');

      const result = await pm.stop('stale-claw');
      expect(result).toBe(true);

      // PID 文件应被清理
      expect(fsSync.existsSync(pidFile)).toBe(false);
    });
  });

  describe('spawn - wx 排他锁', () => {
    it('should throw error when PID file already exists and process is alive', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const clawDir = path.join(tempDir, 'claws', 'existing-claw');
      const pidFile = path.join(clawDir, 'status', 'pid');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      // 预先创建 PID 文件，使用真实运行的进程 PID
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, String(process.pid), 'utf-8');

      // spawn 应抛出 already running 错误
      await expect(pm.spawn('existing-claw', {
        command: 'node',
        args: ['/fake/daemon-entry.js', 'existing-claw'],
        logFile,
        env: { ...process.env },
      })).rejects.toThrow(/already running/);
    });

    it('should throw error with claw name in message', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const clawDir = path.join(tempDir, 'claws', 'busy-claw');
      const pidFile = path.join(clawDir, 'status', 'pid');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      // 使用真实运行的进程 PID
      await fs.writeFile(pidFile, String(process.pid), 'utf-8');

      try {
        await pm.spawn('busy-claw', {
          command: 'node',
          args: ['/fake/daemon-entry.js', 'busy-claw'],
          logFile,
          env: { ...process.env },
        });
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('busy-claw');
        expect(err.message).toContain('already running');
      }
    });

    it('empty PID file triggers console.warn about possible concurrent spawn', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const clawDir = path.join(tempDir, 'claws', 'empty-pid-claw');
      const pidFile = path.join(clawDir, 'status', 'pid');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      // Pre-create an EMPTY PID file (simulates in-progress spawn by another process)
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, '', 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Use 'node --version' as a harmless stand-in; the important thing is the warn happens
      // before the actual spawn, so even if spawn fails afterward that's fine.
      await pm.spawn('empty-pid-claw', {
        command: 'node',
        args: ['--version'],
        logFile,
        env: { ...process.env },
      }).catch(() => {});

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Empty PID file'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('listRunning', () => {
    it('should return empty array when no claws running', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const result = await pm.listRunning();
      expect(result).toEqual([]);
    });

    it('should return running claw IDs', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);

      // 创建两个 claw 目录，一个运行中，一个未运行
      const runningPidFile = path.join(tempDir, 'claws', 'running-claw', 'status', 'pid');
      const stoppedPidFile = path.join(tempDir, 'claws', 'stopped-claw', 'status', 'pid');

      await fs.mkdir(path.dirname(runningPidFile), { recursive: true });
      await fs.writeFile(runningPidFile, process.pid.toString(), 'utf-8');

      await fs.mkdir(path.dirname(stoppedPidFile), { recursive: true });
      await fs.writeFile(stoppedPidFile, '999997', 'utf-8'); // 死进程

      const result = await pm.listRunning();
      expect(result).toContain('running-claw');
      expect(result).not.toContain('stopped-claw');
    });
  });
});
