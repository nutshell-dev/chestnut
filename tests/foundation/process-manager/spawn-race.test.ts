/**
 * spawn — EEXIST race audit 归类（phase 591 / A.spawn-eexist-race-misclassify）
 *
 * 验证点：
 * 1. readSync ENOENT (race) → audit PID_READ_FAILED context=race_check / 不误归类 PID_EMPTY
 * 2. readSync 成功 + 内容空 → audit PID_EMPTY 真语义保留
 * 3. readSync 其他 IO 错（非 ENOENT）→ audit context=eexist_check + reason
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { LockConflictError } from '../../../src/foundation/process-manager/types.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 0 };
});

// spawnDetached injected via ctx (phase 106 DI hygiene)

describe('spawn EEXIST race audit 归类（phase 591 / A.spawn-eexist-race-misclassify）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('spawn-race-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function mockWriteExclusiveOnceEEXIST(): void {
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
  }

  it('readSync ENOENT (race) → audit PID_READ_FAILED context=race_check / 不误归类 PID_EMPTY', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw-race';

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      isReady: () => true,
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    };

    mockWriteExclusiveOnceEEXIST();
    // No readSync mock: pidFile does not exist, so readSync naturally throws
    // FileNotFoundError on the 3rd call (our code in the EEXIST branch).

    const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    expect(result).toBe(FAKE_LIVE_PID);

    const pidReadFailedCalls = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
    );
    expect(pidReadFailedCalls).toHaveLength(1);
    expect(pidReadFailedCalls[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
        expect.stringContaining('daemon_dir='),
        'context=race_check',
      ]),
    );

    const pidEmptyCalls = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_EMPTY,
    );
    expect(pidEmptyCalls).toHaveLength(0);
  });

  it('空 pid file → readPid corrupt + spawn fail closed', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw-empty';

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      isReady: () => true,
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    };

    // Pre-create empty PID file
    const pidFilePath = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFilePath), { recursive: true });
    await fs.writeFile(pidFilePath, '   ', 'utf-8');

    mockWriteExclusiveOnceEEXIST();

    await expect(
      spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      }),
    ).rejects.toBeInstanceOf(LockConflictError);

    expect(ctx.spawnDetached).not.toHaveBeenCalled();

    const pidReadFailedCalls = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
    );
    expect(pidReadFailedCalls).toHaveLength(1);
    expect(pidReadFailedCalls[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
        expect.stringContaining('daemon_dir='),
        'context=eexist_check',
        expect.stringContaining('reason='),
      ]),
    );
  });

  it('readSync 其他 IO 错（非 ENOENT）→ audit context=eexist_check + reason', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw-ioerr';

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      isReady: () => true,
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    };

    mockWriteExclusiveOnceEEXIST();

    // The first readSync call comes from checkAlive (initial).
    // The 2nd call is readLockPid (lockFile).
    // The 3rd call is our explicit readSync in the EEXIST branch.
    let readSyncCallCount = 0;
    vi.spyOn(nodeFs, 'readSync').mockImplementation((p: string) => {
      readSyncCallCount++;
      if (readSyncCallCount === 3) {
        const err = new Error('EACCES permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (NodeFileSystem.prototype as any).readSync.call(nodeFs, p);
    });

    const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    expect(result).toBe(FAKE_LIVE_PID);

    const pidReadFailedCalls = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
    );
    expect(pidReadFailedCalls).toHaveLength(1);
    expect(pidReadFailedCalls[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
        expect.stringContaining('daemon_dir='),
        'context=eexist_check',
        expect.stringContaining('reason='),
      ]),
    );
  });
});
