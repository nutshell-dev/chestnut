/**
 * ProcessManager 单元测试（Phase 1204 Step E：generation 权威）
 *
 * 测试可隔离的纯逻辑单元（不涉及真实子进程启动）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../helpers/daemon-dir.js';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { createSystemAudit } from '../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { DEAD_PID } from '../helpers/dead-pid.js';
import { writeActiveGenerationSync } from '../helpers/generation-fixtures.js';

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
    it('should return false when no active generation exists', () => {
      const result = processManager.getAliveStatus(testClawDaemonDir(tempDir, 'nonexistent-claw')).alive;
      expect(result).toBe(false);
    });

    it('should return false when active generation is malformed', () => {
      const daemonDir = testClawDaemonDir(tempDir, 'malformed-claw');
      const activeDir = path.join(daemonDir, 'status', 'process', 'active');
      fs.mkdirSync(activeDir, { recursive: true });
      fs.writeFileSync(path.join(activeDir, 'generation.json'), 'not-a-number');

      const result = processManager.getAliveStatus(daemonDir).alive;
      expect(result).toBe(false);
    });

    it('should return false when active pid record is missing', () => {
      const daemonDir = testClawDaemonDir(tempDir, 'no-pid-claw');
      const activeDir = path.join(daemonDir, 'status', 'process', 'active');
      fs.mkdirSync(activeDir, { recursive: true });
      fs.writeFileSync(
        path.join(activeDir, 'generation.json'),
        JSON.stringify({ schema_version: 1, generation_id: 'gen-1', daemon_dir: daemonDir, parent_pid: process.pid, created_at: new Date().toISOString() }),
      );

      const result = processManager.getAliveStatus(daemonDir).alive;
      expect(result).toBe(false);
    });
  });

  describe('stop', () => {
    it('should return false when no active generation exists', async () => {
      const result = await processManager.stop(testClawDaemonDir(tempDir, 'nonexistent-claw'));
      expect(result).toBe(false);
    });

    it('probe 不删 stale generation（phase 879 M#1 单一职责）', async () => {
      const daemonDir = testClawDaemonDir(tempDir, 'test-claw');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: DEAD_PID });

      expect(processManager.getAliveStatus(daemonDir).alive).toBe(false);

      // generation 文件不应被 probe 清理（M#1 probe ≠ delete）
      expect(fs.existsSync(path.join(daemonDir, 'status', 'process', 'active', 'generation.json'))).toBe(true);
    });

    it('stop 直读 l1IsAlive 并 retire dead active generation（phase 879）', async () => {
      const daemonDir = testClawDaemonDir(tempDir, 'test-claw-2');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-2', pid: DEAD_PID });

      const result = await processManager.stop(daemonDir);
      expect(result).toBe(true);

      // active generation 应该被 stop 处置到 retired
      expect(fs.existsSync(path.join(daemonDir, 'status', 'process', 'active', 'generation.json'))).toBe(false);
    });
  });

  describe('dirResolver', () => {
    it('should use default path (claws/{id}) when no resolver provided', () => {
      const daemonDir = testClawDaemonDir(tempDir, 'test-claw');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: 12345 });

      const result = processManager.getAliveStatus(daemonDir).alive;
      expect(result).toBe(false);
    });

    it('should read motion daemonDir when caller resolves path', () => {
      const motionDir = testMotionDaemonDir(tempDir);
      writeActiveGenerationSync(motionDir, { generationId: 'gen-motion', pid: 12345 });

      const result = processManager.getAliveStatus(motionDir).alive;
      expect(result).toBe(false);
    });

    it('should read claw daemonDir when caller resolves path', () => {
      const daemonDir = testClawDaemonDir(tempDir, 'test-claw');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: 12345 });

      const result = processManager.getAliveStatus(daemonDir).alive;
      expect(result).toBe(false);
    });
  });

  describe('getAliveStatus edge cases', () => {
    it('malformed active generation returns alive:false', () => {
      const daemonDir = testClawDaemonDir(tempDir, 'bad-gen-claw');
      const activeDir = path.join(daemonDir, 'status', 'process', 'active');
      fs.mkdirSync(activeDir, { recursive: true });
      fs.writeFileSync(path.join(activeDir, 'generation.json'), 'not-json');

      const result = processManager.getAliveStatus(daemonDir);
      expect(result.alive).toBe(false);
      expect(result.reason).toMatch(/malformed/i);
    });

    it('missing active generation returns alive:false', () => {
      const result = processManager.getAliveStatus(testClawDaemonDir(tempDir, 'no-gen-claw'));
      expect(result.alive).toBe(false);
      expect(result.reason).toMatch(/no active generation/i);
    });
  });

  describe('isAlive with live process', () => {
    it('should return true when active generation points to current process', () => {
      const daemonDir = testClawDaemonDir(tempDir, 'live-claw');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-live', pid: process.pid });

      const result = processManager.getAliveStatus(daemonDir).alive;
      expect(result).toBe(true);
    });
  });

  describe('spawn', () => {
    it('should throw error when active generation is alive', async () => {
      const daemonDir = testClawDaemonDir(tempDir, 'existing-claw');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-existing', pid: process.pid });

      await expect(
        processManager.spawn(daemonDir, {
          command: 'node',
          args: ['/fake/daemon-entry.js', 'existing-claw'],
          logFile: path.join(tempDir, 'claws', 'existing-claw', 'logs', 'daemon.log'),
          env: { ...process.env },
        })
      ).rejects.toThrow(/already running/);
    });

    it('should throw error with correct message when process is alive', async () => {
      const daemonDir = testClawDaemonDir(tempDir, 'busy-claw');
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-busy', pid: process.pid });

      try {
        await processManager.spawn(daemonDir, {
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
