/**
 * spawn.ts — I/O error fail closed, no dual daemon (Phase 1003)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { LockConflictError } from '../../../src/foundation/process-manager/types.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 0 };
});

describe('spawn Phase 1003 I/O fail closed', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('spawn-io-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('throws LockConflictError when pidfile read returns I/O error', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'spawn-ioerr';
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      // Bypass initial alive precheck so we reach the EEXIST recovery path
      isAlive: () => false,
      isReady: () => true,
      l1IsAlive: vi.fn().mockReturnValue(false),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    };

    let writeExclusiveCallCount = 0;
    vi.spyOn(nodeFs, 'writeExclusiveSync').mockImplementation((p: string, c: string) => {
      writeExclusiveCallCount++;
      if (writeExclusiveCallCount === 1) {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      return (NodeFileSystem.prototype as any).writeExclusiveSync.call(nodeFs, p, c);
    });

    vi.spyOn(nodeFs, 'read').mockImplementation(async (p: string) => {
      if (p.endsWith('/pid')) {
        const err = new Error('EIO') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      return (NodeFileSystem.prototype as any).read.call(nodeFs, p);
    });

    await expect(
      spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      }),
    ).rejects.toBeInstanceOf(LockConflictError);

    expect(ctx.spawnDetached).not.toHaveBeenCalled();

    const pidReadFailed = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
    );
    expect(pidReadFailed.length).toBeGreaterThanOrEqual(1);
  });
});
