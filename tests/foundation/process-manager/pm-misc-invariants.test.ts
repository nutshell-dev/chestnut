/**
 * PM misc invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - signal-clean-stop.test.ts
 *  - alive-conservative.test.ts
 *  - lock-conflict-error-message.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { signalCleanStop } from '../../../src/foundation/process-manager/signal-clean-stop.js';
import { makeDaemonDir } from '../../../src/foundation/process-manager/index.js';
import { getAliveStatus } from '../../../src/foundation/process-manager/alive.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { LockConflictError, makeDaemonDir as makeDaemonDirFromTypes, type ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDirSync, cleanupTempDirSync } from '../../utils/temp.js';

describe('signal-clean-stop', () => {
  describe('signalCleanStop (phase 1373 sub-3)', () => {
    it('应写入 clean-stop 标记并 audit', async () => {
      const fs = {
        writeAtomic: vi.fn().mockResolvedValue(undefined),
      } as any;
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any;

      await signalCleanStop(fs, makeDaemonDir('/data/chestnut/motion'), audit);

      expect(fs.writeAtomic).toHaveBeenCalledWith(
        '/data/chestnut/motion/clean-stop',
        '',
      );
      expect(audit.write).toHaveBeenCalledWith(
        'clean_stop_signaled',
        'daemon_dir=/data/chestnut/motion',
      );
    });

    it('无 audit 时应写标记但不抛错', async () => {
      const fs = {
        writeAtomic: vi.fn().mockResolvedValue(undefined),
      } as any;

      await expect(
        signalCleanStop(fs, makeDaemonDir('/data/chestnut/claws/claw-a'), undefined),
      ).resolves.toBeUndefined();

      expect(fs.writeAtomic).toHaveBeenCalledWith(
        '/data/chestnut/claws/claw-a/clean-stop',
        '',
      );
    });
  });
});

/**
 * Phase 912 — alive.ts conservative liveness verdicts
 *
 * Verifies that EPERM (process exists but cannot be signalled) and unreadable
 * PID files are treated as alive, preventing duplicate daemon startup.
 */
describe('alive-conservative', () => {
  let lastTempDir: string;

  function makeTempDir(): string {
    const dir = createTrackedTempDirSync('alive-conservative-');
    fs.mkdirSync(dir, { recursive: true });
    lastTempDir = dir;
    return dir;
  }

  function makeDaemonDirAt(base: string, ...segments: string[]): ReturnType<typeof makeDaemonDirFromTypes> {
    const dir = path.join(base, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    return makeDaemonDirFromTypes(dir);
  }

  function makeCtx(tempDir: string, overrides?: Partial<ProcessManagerContext>): ProcessManagerContext {
    return {
      fs: new NodeFileSystem({ baseDir: tempDir }),
      audit: {
        write: () => {},
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      },
      ...overrides,
    } as ProcessManagerContext;
  }

  describe('getAliveStatus conservative verdicts (phase 912)', () => {
    afterEach(() => {
      if (lastTempDir) {
        cleanupTempDirSync(lastTempDir);
        lastTempDir = '';
      }
    });
    it('returns alive=true on EPERM (process exists, cannot probe)', () => {
      const tempDir = makeTempDir();
      const daemonDir = makeDaemonDirAt(tempDir, 'claws', 'epid-claw');

      // PID file points at some PID; L1 probe reports EPERM.
      const pidFile = path.join(tempDir, 'claws', 'epid-claw', 'status', 'pid');
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, '12345');

      const l1IsAlive = vi.fn().mockImplementation(() => {
        const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });

      const result = getAliveStatus(makeCtx(tempDir, { l1IsAlive }), daemonDir);
      expect(result.alive).toBe(true);
      expect(result.reason).toContain('EPERM');
    });

    it('returns alive=true when PID file cannot be read', () => {
      const tempDir = makeTempDir();
      const daemonDir = makeDaemonDirAt(tempDir, 'claws', 'ioerr-claw');

      // fs.readSync will throw EACCES.
      const nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.spyOn(nodeFs, 'readSync').mockImplementation(() => {
        const err = new Error('Permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      const result = getAliveStatus(makeCtx(tempDir, { fs: nodeFs }), daemonDir);
      expect(result.alive).toBe(true);
    });
  });
});

describe('lock-conflict-error-message', () => {
  describe('LockConflictError default message', () => {
    it('does not contain "daemon" in the default message (M#5 generic)', () => {
      const err = new LockConflictError('test-claw');
      expect(err.message).not.toContain('daemon');
    });

    it('contains generic "another process holds the lock" in the default message', () => {
      const err = new LockConflictError('test-claw');
      expect(err.message).toContain('another process holds the lock');
    });

    it('allows custom message override', () => {
      const custom = 'custom lock message';
      const err = new LockConflictError('test-claw', custom);
      expect(err.message).toBe(custom);
    });
  });
});
