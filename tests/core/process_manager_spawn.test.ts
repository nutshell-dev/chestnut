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
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Mock constants to eliminate sleep delays in spawn()
// Mirror stop-race.test.ts:24-27 pattern — mock the correct constants module
// so DAEMON_SHUTDOWN_GRACE_MS used in spawn.ts:52 is overridden to 0.
vi.mock('../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0 };
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
    spawn: vi.fn().mockReturnValue({ pid: process.pid, unref: vi.fn() }),
  };
});

import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../helpers/audit.js';
import { spawnSync, spawn } from 'child_process';  // phase 274: hoist 4 dyn imports (vi.mock above hoisted)

let tempDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `pm-spawn-p19-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: tempDir });
  vi.clearAllMocks();
  // Mock isReady so spawn poll passes without a real daemon writing ready marker
  vi.spyOn(ProcessManager.prototype, 'isReady').mockReturnValue(true);
  // Restore default: pgrep no match
  vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as any);
  vi.mocked(spawn).mockReturnValue({ pid: process.pid, unref: vi.fn() } as any);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  vi.restoreAllMocks();
});

describe('ProcessManager.spawn() - Phase 19 daemon-entry.js', () => {
  it('should call spawnSync pgrep with options.args pattern', async () => {
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
      env: { ...process.env },
    });

    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      'pgrep',
      expect.arrayContaining(['-f', `/fake/daemon-entry\\.js ${clawId}`]),
      expect.any(Object),
    );
  });

  it('should SIGTERM orphaned processes found by pgrep', async () => {
    const orphanPid = 99991;
    const clawId = 'orphan-claw';

    // phase 346 B2: cleanupOrphans 现做两步：
    //   1. pgrep → 候选 PID
    //   2. ps -o pid=,command= -p ...PIDs → 候选 cmdline、按 clawId token 二次过滤
    // 测试需 mock 两个 spawnSync 调用，第二个返 cmdline 含 clawId 才会真 kill。
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: `${orphanPid}\n`, stderr: '' } as any);
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: `${orphanPid} node /fake/daemon-entry.js ${clawId}\n`,
      stderr: '',
    } as any);
    vi.mocked(spawn).mockReturnValue({ pid: process.pid, unref: vi.fn() } as any);

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
      env: { ...process.env },
    });

    expect(killSpy).toHaveBeenCalledWith(orphanPid, 'SIGTERM');
  });

  it('throws when stale empty PID file exists', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as any);
    vi.mocked(spawn).mockReturnValue({ pid: process.pid, unref: vi.fn() } as any);

    const clawId = 'stale-empty-claw';
    const statusDir = path.join(tempDir, 'claws', clawId, 'status');
    await fs.mkdir(statusDir, { recursive: true });
    // Pre-create empty PID file
    await fs.writeFile(path.join(statusDir, 'pid'), '', 'utf-8');

    const { audit, events } = makeAudit();
    const pm = new ProcessManager(nodeFs, audit);
    const clawDir = path.join(tempDir, 'claws', clawId);
    const logFile = path.join(clawDir, 'logs', 'daemon.log');

    await expect(pm.spawn(testClawDaemonDir(tempDir, clawId), {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile,
      env: { ...process.env },
    })).rejects.toThrow(/Cannot determine pidfile state/);
    expect(events.some(e => e[0] === 'pid_read_failed' && e.some((c: string | number | boolean) => typeof c === 'string' && c.includes('stale-empty-claw')))).toBe(true);
  });
});
