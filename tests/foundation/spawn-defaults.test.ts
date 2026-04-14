/**
 * ProcessManager spawn 默认参数和环境变量测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';

function createTempDir(): string {
  const tempDir = path.join(tmpdir(), `spawn-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function cleanupTempDir(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

describe('ProcessManager - spawn defaults', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let mockProc: any;

  beforeEach(() => {
    tempDir = createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
    
    // Setup mock process
    mockProc = {
      pid: 12345,
      unref: vi.fn(),
    };
    vi.mocked(spawn).mockReturnValue(mockProc as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanupTempDir(tempDir);
  });

  describe('spawn with SpawnOptions', () => {
    it('should use provided args for regular claw', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const clawDir = path.join(tempDir, 'claws', 'test-claw');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');
      const customArgs = ['/path/to/daemon-entry.js', 'test-claw'];

      // Pre-create logs dir to avoid ENOENT
      fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

      try {
        await pm.spawn('test-claw', {
          command: 'node',
          args: customArgs,
          logFile,
          env: { ...process.env },
        });
      } catch {
        // Expected to fail due to isAlive check
      }

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];

      expect(args[0]).toContain('daemon-entry');
      expect(args[1]).toBe('test-claw');
    });

    it('should use provided args for motion', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const motionDir = path.join(tempDir, 'motion');
      const logFile = path.join(motionDir, 'logs', 'daemon.log');
      const customArgs = ['/path/to/daemon-entry.js', 'motion'];

      // Pre-create logs dir
      fs.mkdirSync(path.join(motionDir, 'logs'), { recursive: true });

      try {
        await pm.spawn('motion', {
          command: 'node',
          args: customArgs,
          logFile,
          env: { ...process.env },
        });
      } catch {
        // Expected to fail due to isAlive check
      }

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];

      expect(args[0]).toContain('daemon-entry');
      expect(args[1]).toBe('motion');
    });

    it('should pass custom args when provided', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const clawDir = path.join(tempDir, 'claws', 'custom-claw');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');
      const customArgs = ['/custom/cli.js', 'custom', 'command'];

      // Pre-create logs dir
      fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

      try {
        await pm.spawn('custom-claw', {
          command: 'node',
          args: customArgs,
          logFile,
          env: { ...process.env },
        });
      } catch {
        // Expected to fail
      }

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const args = spawnCall[1] as string[];

      expect(args).toEqual(customArgs);
    });
  });

  describe('spawn environment', () => {
    it('should pass env from SpawnOptions', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const clawDir = path.join(tempDir, 'claws', 'env-claw');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      // Pre-create logs dir
      fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

      const customEnv = { ...process.env, CUSTOM_VAR: 'custom-value' };

      try {
        await pm.spawn('env-claw', {
          command: 'node',
          args: ['/path/to/daemon-entry.js', 'env-claw'],
          logFile,
          env: customEnv,
        });
      } catch {
        // Expected to fail
      }

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const options = spawnCall[2] as any;

      expect(options.env).toMatchObject(customEnv);
    });

    it('should inherit parent environment variables when env not provided', async () => {
      const pm = new ProcessManager(nodeFs, tempDir);
      const clawDir = path.join(tempDir, 'claws', 'inherit-claw');
      const logFile = path.join(clawDir, 'logs', 'daemon.log');

      // Pre-create logs dir
      fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

      // Set a test env var
      process.env.TEST_INHERITANCE = 'test-value';

      try {
        await pm.spawn('inherit-claw', {
          command: 'node',
          args: ['/path/to/daemon-entry.js', 'inherit-claw'],
          logFile,
        });
      } catch {
        // Expected to fail
      }

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const options = spawnCall[2] as any;

      expect(options.env).toHaveProperty('TEST_INHERITANCE', 'test-value');

      // Cleanup
      delete process.env.TEST_INHERITANCE;
    });
  });
});
