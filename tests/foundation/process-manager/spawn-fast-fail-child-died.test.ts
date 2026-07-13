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

// getProcessStartTime injected via ctx (phase 106 DI hygiene)
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 10 };
});

// spawnDetached injected via ctx (phase 106 DI hygiene)

describe('spawn poll child-died fast-fail（phase 1136 / F.1，phase 1317 升级 event-driven）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tempDir = path.join(tmpdir(), `spawn-fast-fail-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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
        // call 1 = initial check at spawnProcess entry (must be false to proceed)
        // call 2 = first poll iteration → false to simulate child died during boot
        return false;
      },
      isReady: () => false,
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: process.pid }),
      getProcessStartTime: vi.fn().mockReturnValue(undefined),
    };

    await expect(
      spawnProcess(ctx, clawId, {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(`Process "${clawId}" died during boot`);

    // Event-driven fast-fail causal signature (phase 1317 + phase 1379):
    // - call 1 = initial entry check (spawn.ts:28)
    // - call 2 = first poll iteration alive check (spawn.ts:195) → throws
    // exactly 2 calls proves no wall-clock deadline / no slow-poll fallback.
    // Replaces prior `elapsed < 200ms` magic-number timing assertion (flaky
    // under concurrent worker CPU load even when logic is correctly fast-fail).
    const EXPECTED_ISALIVE_CALLS_ON_FAST_FAIL = 2;
    expect(aliveCallCount).toBe(EXPECTED_ISALIVE_CALLS_ON_FAST_FAIL);
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
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: process.pid }),
      getProcessStartTime: vi.fn().mockReturnValue(undefined),
    };

    const result = await spawnProcess(ctx, clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    expect(result).toBe(process.pid);
  });
});
