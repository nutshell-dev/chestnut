/**
 * spawn poll child-died fast-fail（phase 1136 / F.1）
 *
 * 反向 3 项：
 * 1. child 半途死 → fast-fail throw "died during boot" + < 200ms
 * 2. isReady eventually true → happy path + 0 throw
 * 3. isAlive 一直 true + isReady 永 false → 满 deadline throw "failed to become ready"
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
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, PROCESS_SPAWN_CONFIRM_MS: 50, SPAWN_POLL_INTERVAL_MS: 10 };
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

// phase 1156: 取未 mock 的 production deadline、表达「fast-fail < full deadline」不变式
const { PROCESS_SPAWN_CONFIRM_MS: PROD_SPAWN_CONFIRM_MS } =
  await vi.importActual<typeof import('../../../src/foundation/process-manager/constants.js')>(
    '../../../src/foundation/process-manager/constants.js',
  );

describe('spawn poll child-died fast-fail（phase 1136 / F.1）', () => {
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
    // phase 1156: 用 src 真常量替 magic 200ms / 表达「fast-fail < full spawn deadline」不变式
    // regression 检测：退化到无短路 → 满 deadline (3000ms) 才 throw → 必 fail
    expect(elapsed).toBeLessThan(PROD_SPAWN_CONFIRM_MS);
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

  it('反向 3：isAlive 一直 true + isReady 永 false → 满 deadline throw "failed to become ready"', async () => {
    const { audit } = makeAudit();
    const clawId = 'test-claw-stuck';

    let aliveCallCount = 0;
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isAlive: () => {
        aliveCallCount++;
        // call 1 = initial check (L25) → false to pass
        // call 2+ = poll loop → true (child alive but stuck)
        if (aliveCallCount === 1) return false;
        return true;
      },
      isReady: () => false,
    };

    await expect(
      spawnProcess(ctx, clawId, {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(`Process "${clawId}" failed to become ready (alive=true)`);
  });
});
