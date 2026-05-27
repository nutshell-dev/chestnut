/**
 * spawn — EEXIST race audit 归类（phase 591 / A.spawn-eexist-race-misclassify）
 *
 * 验证点：
 * 1. readSync ENOENT (race) → audit PID_READ_FAILED context=race_check / 不误归类 PID_EMPTY
 * 2. readSync 成功 + 内容空 → audit PID_EMPTY 真语义保留
 * 3. readSync 其他 IO 错（非 ENOENT）→ audit context=eexist_check + reason
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 0 };
});

// Mock spawnDetached so no real process starts; mock isAlive so poll passes
vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    isAlive: vi.fn().mockReturnValue(true),
  };
});

describe('spawn EEXIST race audit 归类（phase 591 / A.spawn-eexist-race-misclassify）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();

    const { spawnDetached, isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(spawnDetached).mockReturnValue({ pid: FAKE_LIVE_PID } as any);
    vi.mocked(isAlive).mockReturnValue(true);

    tempDir = path.join(tmpdir(), `spawn-race-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isReady: () => true,
    };

    mockWriteExclusiveOnceEEXIST();
    // No readSync mock: pidFile does not exist, so readSync naturally throws
    // FileNotFoundError on the 3rd call (our code in the EEXIST branch).

    const result = await spawnProcess(ctx, clawId, {
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
        expect.stringContaining('claw='),
        'context=race_check',
      ]),
    );

    const pidEmptyCalls = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_EMPTY,
    );
    expect(pidEmptyCalls).toHaveLength(0);
  });

  it('readSync 成功 + 内容空 → audit PID_EMPTY 真语义保留', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw-empty';

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isReady: () => true,
    };

    // Pre-create empty PID file so readSync succeeds in the EEXIST branch
    const pidFilePath = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFilePath), { recursive: true });
    await fs.writeFile(pidFilePath, '   ', 'utf-8');

    mockWriteExclusiveOnceEEXIST();

    const result = await spawnProcess(ctx, clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    expect(result).toBe(FAKE_LIVE_PID);

    const pidEmptyCalls = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_EMPTY,
    );
    expect(pidEmptyCalls).toHaveLength(1);
    expect(pidEmptyCalls[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PID_EMPTY,
        expect.stringContaining('claw='),
      ]),
    );
  });

  it('readSync 其他 IO 错（非 ENOENT）→ audit context=eexist_check + reason', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw-ioerr';

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isReady: () => true,
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

    const result = await spawnProcess(ctx, clawId, {
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
        expect.stringContaining('claw='),
        'context=eexist_check',
        expect.stringContaining('reason='),
      ]),
    );
  });
});
