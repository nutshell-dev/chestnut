/**
 * spawn poll child-died fast-fail（phase 1136 / F.1，phase 1317 升级 event-driven）
 *
 * 反向 2 项：
 * 1. child 半途死 → fast-fail throw "died during boot" + < 200ms
 * 2. isReady eventually true → happy path + 0 throw
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';

// Mock getProcessStartTime to avoid slow ps call in tests
vi.mock('../../../src/foundation/process-exec/process-starttime.js', () => ({
  getProcessStartTime: vi.fn().mockReturnValue(undefined),
}));
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 10 };
});

// Mock spawnDetached so no real process starts
vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    isAlive: vi.fn().mockReturnValue(true),
  };
});

describe('spawn poll child-died fast-fail（phase 1136 / F.1，phase 1317 升级 event-driven）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();

    const { spawnDetached } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(spawnDetached).mockReturnValue({ pid: process.pid } as any);

    tempDir = path.join(tmpdir(), `spawn-fast-fail-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('反向 1：child 半途死 → fast-fail throw "died during boot"', async () => {
    const { audit } = makeAudit();
    const clawId = 'test-claw-die';

    let aliveCallCount = 0;
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isAlive: () => {
        aliveCallCount++;
        // call 1 = initial check (L25) → false to pass
        // call 2+ = poll loop → false to simulate child died during boot
        if (aliveCallCount === 1) return false;
        return false;
      },
      isReady: () => false,
    };

    const start = Date.now();
    await expect(
      spawnProcess(ctx, clawId, {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(`Process "${clawId}" died during boot`);
    const elapsed = Date.now() - start;
    // phase 1317: event-driven fast-fail (< 200ms) without wall-clock deadline magic
    expect(elapsed).toBeLessThan(200);
  });

  it('反向 2：isReady eventually true → happy path + 0 throw', async () => {
    const { audit } = makeAudit();
    const clawId = 'test-claw-ready';

    let aliveCallCount = 0;
    let readyCallCount = 0;
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isAlive: () => {
        aliveCallCount++;
        // call 1 = initial check (L25) → false to pass
        // call 2+ = poll loop → true (child alive)
        if (aliveCallCount === 1) return false;
        return true;
      },
      isReady: () => {
        readyCallCount++;
        // initial call (ready = isReady(clawId)) counts as 1
        return readyCallCount >= 3;
      },
    };

    const result = await spawnProcess(ctx, clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    expect(result).toBe(process.pid);
  });
});
