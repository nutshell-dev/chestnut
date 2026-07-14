/**
 * spawn event-driven readiness（phase 1317）
 *
 * 反向 3 项：
 * 1. slow-boot (many polls) → spawn 仍成功 / 无 deadline timeout
 * 2. child crash during boot → fast-fail throw "died during boot"
 * 3. lint grep ban PROCESS_SPAWN_CONFIRM_MS in src/ and tests/
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execSync } from 'node:child_process';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';

// getProcessStartTime injected via ctx (phase 106 DI hygiene)
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { makeAudit } from '../../helpers/audit.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

// Mock constants: tiny poll interval so slow-boot test runs fast
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 1 };
});

// spawnDetached injected via ctx (phase 106 DI hygiene)

describe('phase 1317 spawn event-driven readiness', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('spawn-event-driven-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('slow ready (many polls) → spawn resolves with pid / no deadline timeout', async () => {
    const { audit } = makeAudit();
    const clawId = 'slow-boot-claw';

    let aliveCallCount = 0;
    let readyCallCount = 0;
    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
      isAlive: () => {
        aliveCallCount++;
        // call 1 = initial check (L26) → false to pass
        // call 2+ = poll loop → true (child alive)
        if (aliveCallCount === 1) return false;
        return true;
      },
      isReady: () => {
        readyCallCount++;
        // Simulate a slow boot that takes many poll cycles (> old 3000ms deadline would have expired)
        return readyCallCount >= 100;
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
    expect(readyCallCount).toBeGreaterThanOrEqual(100);
  });

  it('isAliveByPidFile false → fast-fail throw "died during boot"', async () => {
    const { audit } = makeAudit();
    const clawId = 'crash-claw';

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
  });

  it('grep ban PROCESS_SPAWN_CONFIRM_MS in src/ and tests/ (excluding this file)', () => {
    const testFileName = 'spawn-event-driven-readiness.test.ts';
    let out = '';
    try {
      // phase 1491: cwd 改 process.cwd() / 原硬编码 worktree/phase1317 在 CI + 其他 worktree 上不存在
      out = execSync(
        `grep -rn "PROCESS_SPAWN_CONFIRM_MS" src/ tests/ --include="*.ts" --exclude="${testFileName}"`,
        { encoding: 'utf-8', cwd: process.cwd() },
      ).trim();
    } catch (err: any) {
      if (err.status !== 1) throw err;
      out = '';
    }
    expect(out, `Forbidden PROCESS_SPAWN_CONFIRM_MS reference:\n${out}`).toBe('');
  });
});
