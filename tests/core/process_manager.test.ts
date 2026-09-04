/**
 * ProcessManager 测试 - 进程管理核心逻辑（Phase 1204 Step E：generation 权威）
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
    spawn: vi.fn().mockImplementation(() => makeFakeSpawnedChild(process.pid)),
  };
});

import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { ProcessListUnavailable } from '../../src/foundation/process-exec/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeAudit } from '../helpers/audit.js';
import { spawnSync, spawn } from 'child_process';  // phase 273: hoist 5 dyn imports (vi.mock above hoisted by vitest)
import { DEAD_PID } from '../helpers/dead-pid.js';
import { makeFakeSpawnedChild } from '../helpers/fake-spawned-child.js';
import { writeActiveGenerationSync } from '../helpers/generation-fixtures.js';

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
    vi.mocked(spawn).mockImplementation(() => makeFakeSpawnedChild(process.pid) as unknown as ReturnType<typeof import('child_process').spawn>);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    vi.restoreAllMocks();
  });

  describe('dirResolver - 默认路径', () => {
    it('should use claws/{id} active generation as default path', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const daemonDir = testClawDaemonDir(tempDir, 'test-claw');

      writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

      expect(pm.getAliveStatus(daemonDir).alive).toBe(true);
    });

    it('should return false when no active generation exists', () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      expect(pm.getAliveStatus(testClawDaemonDir(tempDir, 'nonexistent')).alive).toBe(false);
    });
  });

  // phase 694: 撤"dirResolver - 自定义路径"测试 — PM 不再持 resolver、
  // motion-vs-claw 拓扑映射归 L4 ClawTopology.resolveClawDaemonDir、PM 仅 take dir
  describe('motion daemonDir (caller-resolved)', () => {
    it('PM 直 take motion daemonDir、不区分 motion vs claw', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const motionDir = testMotionDaemonDir(tempDir);
      writeActiveGenerationSync(motionDir, { generationId: 'gen-motion', pid: process.pid });

      expect(pm.getAliveStatus(motionDir).alive).toBe(true);
    });
  });

  describe('getAliveStatus - 进程检测', () => {
    it('should return true for current process PID', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const daemonDir = testClawDaemonDir(tempDir, 'live-claw');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-live', pid: process.pid });

      expect(pm.getAliveStatus(daemonDir).alive).toBe(true);
    });

    it('should return false and not clean stale generation for dead process (phase 879 M#1)', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const daemonDir = testClawDaemonDir(tempDir, 'dead-claw');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-dead', pid: DEAD_PID });

      expect(pm.getAliveStatus(daemonDir).alive).toBe(false);

      // M#1 probe ≠ delete：getAliveStatus 不清理 stale generation、留到 stop/recovery 显式路径
      expect(fsSync.existsSync(path.join(daemonDir, 'status', 'process', 'active', 'generation.json'))).toBe(true);
    });

    it('should return false for malformed active generation', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const daemonDir = testClawDaemonDir(tempDir, 'invalid-claw');
      const activeDir = path.join(daemonDir, 'status', 'process', 'active');
      await fs.mkdir(activeDir, { recursive: true });
      await fs.writeFile(path.join(activeDir, 'generation.json'), 'not-json', 'utf-8');

      expect(pm.getAliveStatus(daemonDir).alive).toBe(false);
    });
  });

  describe('stop - 停止进程', () => {
    it('should return false when no active generation exists', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const result = await pm.stop(testClawDaemonDir(tempDir, 'nonexistent'));
      expect(result).toBe(false);
    });

    it('should return true and retire stale active generation for dead process', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const daemonDir = testClawDaemonDir(tempDir, 'stale-claw');
      const generationId = 'gen-stale';
      writeActiveGenerationSync(daemonDir, { generationId, pid: DEAD_PID });

      const result = await pm.stop(daemonDir);
      expect(result).toBe(true);

      // active generation 应被 retired
      expect(fsSync.existsSync(path.join(daemonDir, 'status', 'process', 'active', 'generation.json'))).toBe(false);
    });
  });

  describe('spawn - generation conflict', () => {
    it('should throw error when active generation is alive', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const daemonDir = testClawDaemonDir(tempDir, 'existing-claw');
      const logFile = path.join(daemonDir, 'logs', 'daemon.log');

      writeActiveGenerationSync(daemonDir, { generationId: 'gen-existing', pid: process.pid });

      // spawn 应抛出 already running 错误
      await expect(pm.spawn(daemonDir, {
        command: 'node',
        args: ['/fake/daemon-entry.js', 'existing-claw'],
        logFile,
        env: { ...process.env },
      })).rejects.toThrow(/already running/);
    });

    it('should throw error with claw name in message', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, audit);
      const daemonDir = testClawDaemonDir(tempDir, 'busy-claw');
      const logFile = path.join(daemonDir, 'logs', 'daemon.log');

      writeActiveGenerationSync(daemonDir, { generationId: 'gen-busy', pid: process.pid });

      try {
        await pm.spawn(daemonDir, {
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
