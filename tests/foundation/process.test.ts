/**
 * ProcessManager 单元测试
 *
 * 测试可隔离的纯逻辑单元（不涉及真实子进程启动）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../helpers/daemon-dir.js';
import { waitFor } from '../helpers/wait-for.js';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { createSystemAudit } from '../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { DEAD_PID } from '../helpers/dead-pid.js';

describe('ProcessManager', () => {
  let tempDir: string;
  let fsInstance: NodeFileSystem;
  let processManager: ProcessManager;
  let audit: { write: (...args: any[]) => void };
  let auditEvents: Array<[string, ...any[]]>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fsInstance = new NodeFileSystem({ baseDir: tempDir });
    auditEvents = [];
    audit = {
      write: (...args: any[]) => auditEvents.push(args as [string, ...any[]]),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    processManager = new ProcessManager(fsInstance, audit);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('isAlive', () => {
    it('should return false when pid file does not exist', () => {
      const result = processManager.isAlive(testClawDaemonDir(tempDir, 'nonexistent-claw'));
      expect(result).toBe(false);
    });

    it('should return false when pid file contains invalid content', () => {
      // 创建 pid 文件但内容不是有效数字
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), 'not-a-number');

      const result = processManager.isAlive(testClawDaemonDir(tempDir, 'test-claw'));
      expect(result).toBe(false);
    });

    it('should return false when pid file contains empty content', () => {
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), '');

      const result = processManager.isAlive(testClawDaemonDir(tempDir, 'test-claw'));
      expect(result).toBe(false);
    });

    it('should return false when pid file contains whitespace only', () => {
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), '   \n  ');

      const result = processManager.isAlive(testClawDaemonDir(tempDir, 'test-claw'));
      expect(result).toBe(false);
    });
  });

  describe('stop', () => {
    it('should return false when pid file does not exist', async () => {
      const result = await processManager.stop(testClawDaemonDir(tempDir, 'nonexistent-claw'));
      expect(result).toBe(false);
    });

    it('probe 不删 stale pidfile（phase 879 M#1 单一职责）', async () => {
      // 创建一个指向不存在进程的 pid 文件
      const statusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      const pidFile = path.join(statusDir, 'pid');
      
      // 使用一个不可能存在的 PID（Linux 的 PID 上限通常是 2^22，macOS 更低）
      const fakePid = DEAD_PID;
      fs.writeFileSync(pidFile, String(fakePid));

      // isAlive 应该返回 false（因为进程不存在）
      expect(processManager.isAlive(testClawDaemonDir(tempDir, 'test-claw'))).toBe(false);

      // pid 文件不应被 probe 清理（M#1 probe ≠ delete）
      expect(fs.existsSync(pidFile)).toBe(true);
    });

    it('stop 直读 l1IsAlive 清理 stale pidfile 并返回 true（phase 879）', async () => {
      // 创建一个指向不存在进程的 pid 文件
      const statusDir = path.join(tempDir, 'claws', 'test-claw-2', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      const pidFile = path.join(statusDir, 'pid');
      
      const fakePid = DEAD_PID;
      fs.writeFileSync(pidFile, String(fakePid));

      // 直接调用 stop（不先调用 isAlive）
      // stop 经 l1IsAlive(pid) 直读检测到进程不存在，清理 pid 文件，返回 true
      const result = await processManager.stop(testClawDaemonDir(tempDir, 'test-claw-2'));
      expect(result).toBe(true);
      
      // pid 文件应该被 stop 清理
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
      const result = processManager.isAlive(testClawDaemonDir(tempDir, 'test-claw'));
      // 12345 进程大概率不存在，返回 false
      expect(result).toBe(false);
    });

    it('should read motion daemonDir when caller resolves path', () => {
      // phase 694: caller resolves daemonDir, PM no longer holds resolver
      const motionStatusDir = path.join(tempDir, 'motion', 'status');
      fs.mkdirSync(motionStatusDir, { recursive: true });
      fs.writeFileSync(path.join(motionStatusDir, 'pid'), '12345');

      const result = processManager.isAlive(testMotionDaemonDir(tempDir));
      expect(result).toBe(false);
    });

    it('should read claw daemonDir when caller resolves path', () => {
      const clawStatusDir = path.join(tempDir, 'claws', 'test-claw', 'status');
      fs.mkdirSync(clawStatusDir, { recursive: true });
      fs.writeFileSync(path.join(clawStatusDir, 'pid'), '12345');

      const result = processManager.isAlive(testClawDaemonDir(tempDir, 'test-claw'));
      expect(result).toBe(false);
    });
  });

  describe('getAliveStatus edge cases', () => {
    it('空 PID 文件返回 alive:false，reason 含 "empty"', () => {
      const statusDir = path.join(tempDir, 'claws', 'empty-pid-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), '   ');  // 空白

      const result = processManager.getAliveStatus(testClawDaemonDir(tempDir, 'empty-pid-claw'));
      expect(result.alive).toBe(false);
      expect(result.reason).toMatch(/empty/i);
    });

    it('PID 文件内容非数字返回 alive:false，reason 含 "invalid"', () => {
      const statusDir = path.join(tempDir, 'claws', 'bad-pid-claw', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'pid'), 'not-a-number');

      const result = processManager.getAliveStatus(testClawDaemonDir(tempDir, 'bad-pid-claw'));
      expect(result.alive).toBe(false);
      expect(result.reason).toMatch(/invalid/i);
    });

    it('PID 文件不存在返回 alive:false，reason 含 "no PID file"', () => {
      const result = processManager.getAliveStatus(testClawDaemonDir(tempDir, 'no-pid-file-claw'));
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

      const result = processManager.isAlive(testClawDaemonDir(tempDir, 'live-claw'));
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
        processManager.spawn(testClawDaemonDir(tempDir, 'existing-claw'), {
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
        await processManager.spawn(testClawDaemonDir(tempDir, 'busy-claw'), {
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
