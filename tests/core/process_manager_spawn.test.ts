/**
 * ProcessManager.spawn() Phase 19 路径测试
 *
 * 覆盖的新路径：
 * - pgrep orphan scan 使用 daemon-entry.js 模式
 * - 找到孤儿进程 → SIGTERM
 * - stale 空 PID 文件 → 警告后继续
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../helpers/daemon-dir.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

// Mock constants to eliminate sleep delays in spawn()
// Mirror stop-race.test.ts:24-27 pattern — mock the correct constants module
// so DAEMON_SHUTDOWN_GRACE_MS used in spawn.ts:52 is overridden to 0.
vi.mock('../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0 };
});

const orphanQuery = vi.hoisted(() => ({
  calls: [] as string[],
  impl: (() => []) as () => Array<{ pid: number; command: string }>,
}));
vi.mock('../../src/foundation/process-manager/find.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/find.js')>();
  return {
    ...actual,
    findProcessesDetailedAsync: async (
      _ctx: unknown,
      pattern: string,
    ) => {
      orphanQuery.calls.push(pattern);
      return orphanQuery.impl();
    },
  };
});

// Mock child_process so spawn() doesn't actually start a node process
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn().mockImplementation(() => {
      // Default: pgrep finds nothing (exit code 1 = no match)
      return { status: 1, stdout: '', stderr: '' };
    }),
    spawn: vi.fn().mockImplementation(() => makeFakeSpawnedChild(process.pid)),
  };
});

import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../helpers/audit.js';
import { spawnSync, spawn } from 'child_process';  // phase 274: hoist 4 dyn imports (vi.mock above hoisted)
import { makeFakeSpawnedChild } from '../helpers/fake-spawned-child.js';

let tempDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tempDir = await createTrackedTempDir('pm-spawn-p19-');
  nodeFs = new NodeFileSystem({ baseDir: tempDir });
  vi.clearAllMocks();
  orphanQuery.calls = [];
  orphanQuery.impl = () => [];
  // Mock isReady so spawn poll passes without a real daemon writing ready marker
  vi.spyOn(ProcessManager.prototype, 'isReady').mockReturnValue(true);
  // Restore default: pgrep no match
  vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as any);
  vi.mocked(spawn).mockImplementation(() => makeFakeSpawnedChild(process.pid) as any);
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
  vi.restoreAllMocks();
});

describe('ProcessManager.spawn() - Phase 19 daemon-entry.js', () => {
  it('should query the async process-list capability with options.args pattern', async () => {
    const { audit } = makeAudit();
    const pm = new ProcessManager(nodeFs, audit);
    const clawId = 'p19-claw';
    const clawDir = path.join(tempDir, 'claws', clawId);
    const logFile = path.join(clawDir, 'logs', 'daemon.log');
    await fs.mkdir(clawDir, { recursive: true });

    await pm.spawn(clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile,
    });

    expect(orphanQuery.calls).toEqual([`/fake/daemon-entry.js ${clawId}`]);
  });

  it('should SIGTERM orphaned processes found by pgrep', async () => {
    const orphanPid = 99991;
    const clawId = 'orphan-claw';

    // The typed cleanup enumerates complete argv evidence, then verifies the
    // same identity disappeared before permitting the replacement spawn.
    let queries = 0;
    orphanQuery.impl = () => {
      queries++;
      return queries === 1
        ? [{ pid: orphanPid, command: `node /fake/daemon-entry.js ${clawId}` }]
        : [];
    };
    vi.mocked(spawn).mockImplementation(() => makeFakeSpawnedChild(process.pid) as any);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const { audit } = makeAudit();
    const pm = new ProcessManager(nodeFs, audit);
    const clawDir = path.join(tempDir, 'claws', clawId);
    const logFile = path.join(clawDir, 'logs', 'daemon.log');
    await fs.mkdir(clawDir, { recursive: true });

    await pm.spawn(clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile,
    });

    expect(killSpy).toHaveBeenCalledWith(orphanPid, 'SIGTERM');
  });

  it('ignores stale empty legacy PID file and spawns successfully', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as any);
    vi.mocked(spawn).mockImplementation(() => makeFakeSpawnedChild(process.pid) as any);

    const clawId = 'stale-empty-claw';
    const statusDir = path.join(tempDir, 'claws', clawId, 'status');
    await fs.mkdir(statusDir, { recursive: true });
    // Pre-create empty legacy PID file
    await fs.writeFile(path.join(statusDir, 'pid'), '', 'utf-8');

    const { audit } = makeAudit();
    const pm = new ProcessManager(nodeFs, audit);
    const clawDir = path.join(tempDir, 'claws', clawId);
    const logFile = path.join(clawDir, 'logs', 'daemon.log');

    const result = await pm.spawn(testClawDaemonDir(tempDir, clawId), {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile,
    });

    expect(result).toBe(process.pid);
  });
});
