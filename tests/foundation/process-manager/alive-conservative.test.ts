/**
 * Phase 912 — alive.ts conservative liveness verdicts
 *
 * Verifies that EPERM (process exists but cannot be signalled) and unreadable
 * PID files are treated as alive, preventing duplicate daemon startup.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { getAliveStatus } from '../../../src/foundation/process-manager/alive.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeDaemonDir, type ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

let lastTempDir: string;

function makeTempDir(): string {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const dir = path.join(tmpdir(), `alive-conservative-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  lastTempDir = dir;
  return dir;
}

function makeDaemonDirAt(base: string, ...segments: string[]): ReturnType<typeof makeDaemonDir> {
  const dir = path.join(base, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return makeDaemonDir(dir);
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
      try {
        fs.rmSync(lastTempDir, { recursive: true, force: true });
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
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
