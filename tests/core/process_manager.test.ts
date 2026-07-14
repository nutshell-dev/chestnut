/**
 * ProcessManager 测试 - 进程管理核心逻辑
 *
 * 测试通过 public API 进行，不直接调用 private 方法
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../helpers/daemon-dir.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Mock child_process so findProcesses tests can control pgrep behavior
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn().mockImplementation(() => {
      // Default: pgrep finds nothing (exit code 1 = no match)
      return { status: 1, stdout: '', stderr: '' };
    }),
    spawn: vi.fn().mockReturnValue({ pid: process.pid, unref: vi.fn() }),
  };
});

import { ProcessManager, ProcessListUnavailable } from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeAudit } from '../helpers/audit.js';
import { spawnSync, spawn } from 'child_process';  // phase 273: hoist 5 dyn imports (vi.mock above hoisted by vitest)
import { DEAD_PID_STRING } from '../helpers/dead-pid.js';

describe('ProcessManager', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    // 重装 vi.mock factory default（restoreAllMocks 后 chained mockImplementation 失效）
    vi.mocked(spawnSync).mockImplementation(() =>
      ({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }) as ReturnType<typeof import('child_process').spawnSync>
    );
    vi.mocked(spawn).mockReturnValue({ pid: process.pid, unref: vi.fn() } as unknown as ReturnType<typeof import('child_process').spawn>);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    vi.restoreAllMocks();
  });

  describe('dirResolver - 默认路径', () => {
    it('should use claws/{id}/status/pid as default path', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const pidFile = path.join(tempDir, 'claws', 'test-claw', 'status', 'pid');

      // 写入 PID 文件
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, process.pid.toString(), 'utf-8');

      expect(pm.isAlive(testClawDaemonDir(tempDir, 'test-claw'))).toBe(true);
    });

    it('should return false when PID file does not exist', () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      expect(pm.isAlive(testClawDaemonDir(tempDir, 'nonexistent'))).toBe(false);
    });
  });

  // phase 694: 撤"dirResolver - 自定义路径"测试 — PM 不再持 resolver、
  // motion-vs-claw 拓扑映射归 L4 ClawTopology.resolveClawDaemonDir、PM 仅 take dir
  describe('motion daemonDir (caller-resolved)', () => {
    it('PM 直 take motion daemonDir、不区分 motion vs claw', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);

      // caller (test) 算 motion daemonDir = tempDir/motion
      const motionPidFile = path.join(tempDir, 'motion', 'status', 'pid');
      await fs.mkdir(path.dirname(motionPidFile), { recursive: true });
      await fs.writeFile(motionPidFile, process.pid.toString(), 'utf-8');

      expect(pm.isAlive(testMotionDaemonDir(tempDir))).toBe(true);
    });
  });

  describe('isAlive - 进程检测', () => {
    it('should return true for current process PID', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const pidFile = path.join(tempDir, 'claws', 'live-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, process.pid.toString(), 'utf-8');

      expect(pm.isAlive(testClawDaemonDir(tempDir, 'live-claw'))).toBe(true);
    });

    it('should return false and not clean stale PID for dead process (phase 879 M#1)', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const pidFile = path.join(tempDir, 'claws', 'dead-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, DEAD_PID_STRING, 'utf-8'); // 不存在的进程

      expect(pm.isAlive(testClawDaemonDir(tempDir, 'dead-claw'))).toBe(false);

      // M#1 probe ≠ delete：isAlive 不清理 stale pidfile、留到 stop/recovery 显式路径
      expect(fsSync.existsSync(pidFile)).toBe(true);
    });

    it('should return false for invalid PID content', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const pidFile = path.join(tempDir, 'claws', 'invalid-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, 'not-a-number', 'utf-8');

      expect(pm.isAlive(testClawDaemonDir(tempDir, 'invalid-claw'))).toBe(false);
    });
  });

  describe('stop - 停止进程', () => {
    it('should return false when PID file does not exist', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const result = await pm.stop(testClawDaemonDir(tempDir, 'nonexistent'));
      expect(result).toBe(false);
    });

    it('should return true and clean stale PID for dead process', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const pidFile = path.join(tempDir, 'claws', 'stale-claw', 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, DEAD_PID_STRING, 'utf-8');

      const result = await pm.stop(testClawDaemonDir(tempDir, 'stale-claw'));
      expect(result).toBe(true);

      // PID 文件应被清理
      expect(fsSync.existsSync(pidFile)).toBe(false);
    });
  });

  describe('spawn - wx 排他锁', () => {
    it('should throw error when PID file already exists and process is alive', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const clawDir = path.join(tempDir, 'claws', 'existing-claw');
      const pidFile = path.join(clawDir, 'status', 'pid');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      // 预先创建 PID 文件，使用真实运行的进程 PID
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, String(process.pid), 'utf-8');

      // spawn 应抛出 already running 错误
      await expect(pm.spawn(testClawDaemonDir(tempDir, 'existing-claw'), {
        command: 'node',
        args: ['/fake/daemon-entry.js', 'existing-claw'],
        logFile,
        env: { ...process.env },
      })).rejects.toThrow(/already running/);
    });

    it('should throw error with claw name in message', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const clawDir = path.join(tempDir, 'claws', 'busy-claw');
      const pidFile = path.join(clawDir, 'status', 'pid');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      // 使用真实运行的进程 PID
      await fs.writeFile(pidFile, String(process.pid), 'utf-8');

      try {
        await pm.spawn(testClawDaemonDir(tempDir, 'busy-claw'), {
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

    it('empty PID file triggers fail closed on spawn conflict', async () => {
      const { audit, events } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const clawDir = path.join(tempDir, 'claws', 'empty-pid-claw');
      const pidFile = path.join(clawDir, 'status', 'pid');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      // Pre-create an EMPTY PID file
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, '', 'utf-8');

      await expect(
        pm.spawn(testClawDaemonDir(tempDir, 'empty-pid-claw'), {
          command: 'node',
          args: ['--version'],
          logFile,
          env: { ...process.env },
        }),
      ).rejects.toThrow(/Cannot determine pidfile state/);

      expect(events.some(e => e[0] === 'pid_read_failed' && e.some((c: string | number | boolean) => typeof c === 'string' && c.includes('empty-pid-claw')))).toBe(true);
    });
  });

  describe('findProcesses', () => {
    it('should throw ProcessListUnavailable when spawnSync throws (e.g. ENOENT)', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      vi.mocked(spawnSync).mockImplementation(() => {
        const err = Object.assign(new Error('ENOENT: pgrep not found'), { code: 'ENOENT' });
        throw err;
      });

      expect(() => pm.findProcesses('test-pattern')).toThrow(ProcessListUnavailable);
    });

    it('should throw ProcessListUnavailable when pgrep exits with non-0/non-1 status', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      vi.mocked(spawnSync).mockImplementation(() => ({
        status: 2,
        stdout: Buffer.from(''),
        stderr: Buffer.from('invalid regex'),
      }) as ReturnType<typeof import('child_process').spawnSync>);

      expect(() => pm.findProcesses('test-pattern')).toThrow(ProcessListUnavailable);
    });

    it('should return empty array when pgrep exits 1 (no match)', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      vi.mocked(spawnSync).mockImplementation(() => ({
        status: 1,
        stdout: '',
        stderr: '',
      } as any));

      expect(pm.findProcesses('test-pattern')).toEqual([]);
    });
  });

});
