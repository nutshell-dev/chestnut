/**
 * ProcessManager spawn 默认参数和环境变量测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDirSync } from '../utils/temp.js';
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../helpers/audit.js';
import { FAKE_LIVE_PID } from '../helpers/test-pids.js';

// Mock child_process
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 }),
  };
});

import { spawn } from 'child_process';

describe('ProcessManager - spawn defaults', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let mockProc: any;

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir });

    // Setup mock process
    mockProc = {
      pid: FAKE_LIVE_PID,
      unref: vi.fn(),
    };
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    // Mock isAlive/isReady to skip 3s spawn confirm wait
    vi.spyOn(ProcessManager.prototype, 'isAlive')
      .mockReturnValueOnce(false)   // fast-path check: not running
      .mockReturnValueOnce(false)   // lockfile check
      .mockReturnValue(true);       // spawn confirm: alive
    vi.spyOn(ProcessManager.prototype, 'isReady').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempDirSync(tempDir);
  });

  describe('spawn with SpawnOptions', () => {
    it('should use provided args for regular claw', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, tempDir, audit);
      const clawDir = path.join(tempDir, 'claws', 'test-claw');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');
      const customArgs = ['/path/to/daemon-entry.js', 'test-claw'];

      // Pre-create logs dir to avoid ENOENT
      fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

      await pm.spawn('test-claw', {
        command: 'node',
        args: customArgs,
        logFile,
        env: { ...process.env },
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];

      expect(args[0]).toContain('daemon-entry');
      expect(args[1]).toBe('test-claw');
    });

    it('should use provided args for motion', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, tempDir, audit);
      const motionDir = path.join(tempDir, 'motion');
      const logFile = path.join(motionDir, 'logs', 'daemon.log');
      const customArgs = ['/path/to/daemon-entry.js', 'motion'];

      // Pre-create logs dir
      fs.mkdirSync(path.join(motionDir, 'logs'), { recursive: true });

      await pm.spawn('motion', {
        command: 'node',
        args: customArgs,
        logFile,
        env: { ...process.env },
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];

      expect(args[0]).toContain('daemon-entry');
      expect(args[1]).toBe('motion');
    });

    it('should pass custom args when provided', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, tempDir, audit);
      const clawDir = path.join(tempDir, 'claws', 'custom-claw');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');
      const customArgs = ['/custom/cli.js', 'custom', 'command'];

      // Pre-create logs dir
      fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

      await pm.spawn('custom-claw', {
        command: 'node',
        args: customArgs,
        logFile,
        env: { ...process.env },
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];

      expect(args).toEqual(customArgs);
    });
  });

  describe('spawn environment', () => {
    it('should pass env from SpawnOptions', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, tempDir, audit);
      const clawDir = path.join(tempDir, 'claws', 'env-claw');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      // Pre-create logs dir
      fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

      const customEnv = { ...process.env, CUSTOM_VAR: 'custom-value' };

      await pm.spawn('env-claw', {
        command: 'node',
        args: ['/path/to/daemon-entry.js', 'env-claw'],
        logFile,
        env: customEnv,
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const options = spawnCall[2] as any;

      expect(options.env).toMatchObject(customEnv);
    });

    it('should inherit parent environment variables when env not provided', async () => {
      const { audit } = makeAudit();
      const pm = new ProcessManager(nodeFs, tempDir, audit);
      const clawDir = path.join(tempDir, 'claws', 'inherit-claw');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      // Pre-create logs dir
      fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

      // Set test env var with try-finally guard (cleanup even if assertion fails)
      const prevValue = process.env.TEST_INHERITANCE;
      process.env.TEST_INHERITANCE = 'test-value';
      try {
        await pm.spawn('inherit-claw', {
          command: 'node',
          args: ['/path/to/daemon-entry.js', 'inherit-claw'],
          logFile,
        });

        const spawnCall = vi.mocked(spawn).mock.calls[0];
        const options = spawnCall[2] as any;

        expect(options.env).toHaveProperty('TEST_INHERITANCE', 'test-value');
      } finally {
        if (prevValue === undefined) delete process.env.TEST_INHERITANCE;
        else process.env.TEST_INHERITANCE = prevValue;
      }
    });
  });
});
