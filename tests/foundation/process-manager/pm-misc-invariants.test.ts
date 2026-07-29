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
import { ProcessGenerationStateError, ProcessSpawnConflictError, makeDaemonDir as makeDaemonDirFromTypes, type ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDirSync, cleanupTempDirSync } from '../../utils/temp.js';
import { writeActiveGenerationSync } from '../../helpers/generation-fixtures.js';

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
 * Phase 912 / Step E — alive.ts conservative liveness verdicts via generation.
 *
 * Verifies that EPERM (process exists but cannot be signalled) is treated as
 * alive, preventing duplicate daemon startup.
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
      writeActiveGenerationSync(daemonDir, { generationId: 'gen-epid', pid: 12345 });

      const l1IsAlive = vi.fn().mockImplementation(() => {
        const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });

      const result = getAliveStatus(makeCtx(tempDir, { l1IsAlive }), daemonDir);
      expect(result.alive).toBe(true);
      expect(result.reason).toContain('EPERM');
    });
  });
});

describe('spawn-error-taxonomy (Phase 1235)', () => {
  describe('ProcessSpawnConflictError fields', () => {
    it('exposes daemonDir/reason/generationId with default message', () => {
      const daemonDir = makeDaemonDirFromTypes('test-claw');
      const err = new ProcessSpawnConflictError(daemonDir, 'active_owner', 'gen-1');
      expect(err.name).toBe('ProcessSpawnConflictError');
      expect(err.daemonDir).toBe(daemonDir);
      expect(err.reason).toBe('active_owner');
      expect(err.generationId).toBe('gen-1');
      expect(err.message).toContain('active_owner');
      expect(err.message).toContain('gen-1');
    });

    it('accepts all three conflict reasons', () => {
      const daemonDir = makeDaemonDirFromTypes('test-claw');
      expect(new ProcessSpawnConflictError(daemonDir, 'active_owner', 'g').reason).toBe('active_owner');
      expect(new ProcessSpawnConflictError(daemonDir, 'spawn_in_progress', 'g').reason).toBe('spawn_in_progress');
      expect(new ProcessSpawnConflictError(daemonDir, 'commit_lost', 'g').reason).toBe('commit_lost');
    });

    it('allows custom message override', () => {
      const custom = 'custom conflict message';
      const err = new ProcessSpawnConflictError(makeDaemonDirFromTypes('test-claw'), 'commit_lost', 'gen-2', custom);
      expect(err.message).toBe(custom);
    });
  });

  describe('ProcessGenerationStateError fields', () => {
    it('exposes location/operation and preserves original cause', () => {
      const daemonDir = makeDaemonDirFromTypes('test-claw');
      const cause = new SyntaxError('Unexpected token');
      const err = new ProcessGenerationStateError(daemonDir, 'spawning', 'inspect', cause);
      expect(err.name).toBe('ProcessGenerationStateError');
      expect(err.daemonDir).toBe(daemonDir);
      expect(err.location).toBe('spawning');
      expect(err.operation).toBe('inspect');
      expect(err.cause).toBe(cause);
      expect(err.message).toContain('spawning');
      expect(err.message).toContain('inspect');
    });

    it('is not a spawn conflict (distinct class per taxonomy)', () => {
      const err = new ProcessGenerationStateError(makeDaemonDirFromTypes('test-claw'), 'active', 'commit', 'boom');
      expect(err).not.toBeInstanceOf(ProcessSpawnConflictError);
    });

    it('allows custom message override', () => {
      const custom = 'custom state message';
      const err = new ProcessGenerationStateError(makeDaemonDirFromTypes('test-claw'), 'active', 'inspect', 'c', custom);
      expect(err.message).toBe(custom);
    });
  });
});
