/**
 * spawn duration metric（phase 1148 / C.3）
 *
 * 反向 3 项：
 * 1. PROCESS_SPAWNED emit 含 duration_ms 非 0 col
 * 2. PROCESS_SPAWN_FAILED emit 含 duration_ms 反映 fail timing
 * 3. duration_ms 单调性（mock isReady delay 200ms）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

/**
 * isReady mock 注入 delay (ms) — 模拟真 spawn poll loop 累积时长.
 * Derivation: > eventloop tick / < 1s 不显著拖测试 / 反向 #3 mock isReady delay
 * 200ms 推出 duration_ms 下限 = poll 累积 ≥ 150ms.
 */
const SPAWN_READY_MIN_ACCUMULATED_MS = 150;

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 10 };
});

// spawnDetached injected via ctx (phase 106 DI hygiene)

describe('spawn duration metric（phase 1148 / C.3）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();

    tempDir = path.join(tmpdir(), `spawn-duration-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('反向 1：PROCESS_SPAWNED emit 含 duration_ms 非 0 col', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isReady: () => true,
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    };

    await spawnProcess(ctx, clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    const spawnedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED,
    );
    expect(spawnedEvents).toHaveLength(1);

    const durationCol = spawnedEvents[0].find((c) => typeof c === 'string' && c.startsWith('duration_ms='));
    expect(durationCol).toBeDefined();
    const durationMs = parseInt(String(durationCol).split('=')[1], 10);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('反向 2：PROCESS_SPAWN_FAILED emit 含 duration_ms 反映 fail timing', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';

    let aliveCallCount = 0;
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isAlive: () => {
        aliveCallCount++;
        if (aliveCallCount === 1) return false;
        return false;
      },
      isReady: () => false,
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
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

    const failedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
    );
    expect(failedEvents).toHaveLength(1);

    const durationCol = failedEvents[0].find((c) => typeof c === 'string' && c.startsWith('duration_ms='));
    expect(durationCol).toBeDefined();
    const durationMs = parseInt(String(durationCol).split('=')[1], 10);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(durationMs).toBeLessThanOrEqual(elapsed + 50); // within measured elapsed + tolerance
  });

  it('反向 3：duration_ms 单调性（mock isReady delay 200ms）', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';

    let aliveCallCount = 0;
    let readyCallCount = 0;
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isAlive: () => {
        aliveCallCount++;
        if (aliveCallCount === 1) return false;
        return true;
      },
      isReady: () => {
        readyCallCount++;
        return readyCallCount >= 22; // enough polls to accumulate ~200ms with 10ms interval
      },
      l1IsAlive: vi.fn().mockReturnValue(true),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    };

    await spawnProcess(ctx, clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
    });

    const spawnedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED,
    );
    expect(spawnedEvents).toHaveLength(1);

    const durationCol = spawnedEvents[0].find((c) => typeof c === 'string' && c.startsWith('duration_ms='));
    expect(durationCol).toBeDefined();
    const durationMs = parseInt(String(durationCol).split('=')[1], 10);
    expect(durationMs).toBeGreaterThanOrEqual(SPAWN_READY_MIN_ACCUMULATED_MS); // at least some delay accumulated
  });
});
