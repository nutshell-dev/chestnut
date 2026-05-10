/**
 * ProcessManager.spawn() Phase 19 路径测试
 *
 * 覆盖的新路径：
 * - pgrep orphan scan 使用 daemon-entry.js 模式
 * - 找到孤儿进程 → SIGTERM
 * - stale 空 PID 文件 → 警告后继续
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Mock constants to eliminate sleep delays in spawn()
vi.mock('../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, SIGTERM_GRACE_MS: 0, PROCESS_SPAWN_CONFIRM_MS: 0 };
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

let tempDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tempDir = path.join(tmpdir(), `pm-spawn-p19-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: tempDir });
  vi.clearAllMocks();
  // Restore default: pgrep no match
  const { spawnSync, spawn } = await import('child_process');
  vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as any);
  vi.mocked(spawn).mockReturnValue({ pid: process.pid, unref: vi.fn() } as any);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

describe('ProcessManager.spawn() - Phase 19 daemon-entry.js', () => {
  it('should call spawnSync pgrep with options.args pattern', async () => {
    const { spawnSync } = await import('child_process');
    const { audit } = makeAudit();
    const pm = new ProcessManager(nodeFs, tempDir, audit);
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
    const { spawnSync, spawn } = await import('child_process');
    const orphanPid = 99991;

    // pgrep returns one orphan PID
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: `${orphanPid}\n`, stderr: '' } as any);
    vi.mocked(spawn).mockReturnValue({ pid: process.pid, unref: vi.fn() } as any);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const { audit } = makeAudit();
    const pm = new ProcessManager(nodeFs, tempDir, audit);
    const clawId = 'orphan-claw';
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

  it('should warn and continue when stale empty PID file exists', async () => {
    const { spawnSync, spawn } = await import('child_process');
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as any);
    vi.mocked(spawn).mockReturnValue({ pid: process.pid, unref: vi.fn() } as any);

    const clawId = 'stale-empty-claw';
    const statusDir = path.join(tempDir, 'claws', clawId, 'status');
    await fs.mkdir(statusDir, { recursive: true });
    // Pre-create empty PID file (simulates concurrent spawn leaving an empty file)
    await fs.writeFile(path.join(statusDir, 'pid'), '', 'utf-8');

    const { audit, events } = makeAudit();
    const pm = new ProcessManager(nodeFs, tempDir, audit);
    const clawDir = path.join(tempDir, 'claws', clawId);
    const logFile = path.join(clawDir, 'logs', 'daemon.log');

    await expect(pm.spawn(clawId, {
      command: 'node',
      args: ['/fake/daemon-entry.js', clawId],
      logFile,
      env: { ...process.env },
    })).resolves.toBeDefined();
    expect(events.some(e => e[0] === 'pid_empty' && e.some((c: string | number | boolean) => typeof c === 'string' && c.includes('claw=stale-empty-claw')))).toBe(true);
  });
});
