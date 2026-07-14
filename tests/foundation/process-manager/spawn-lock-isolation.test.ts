/**
 * spawn 锁与生命周期锁隔离反向测试（Phase 1019）
 *
 * 背景：acquireLockFile 的 EEXIST 分支曾误用 readLock 硬编码读 daemon.lock，
 * 导致 spawn 锁（daemon.lock.spawn）EEXIST 时误读生命周期锁文件。
 *
 * 验证点：
 * 1. spawn 锁被活进程持有 + 生命周期锁不存在 → acquireSpawnLock 抛
 *    LockConflictError，不回收/不删除 spawn 锁（修复前会误判 missing 并回收）
 * 2. 生命周期锁被活进程持有 + spawn 锁 stale → acquireSpawnLock 正常回收
 *    stale spawn 锁成功，生命周期锁原样不动（两把锁互不干扰）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { acquireSpawnLock } from '../../../src/foundation/process-manager/lock.js';
import { LockConflictError } from '../../../src/foundation/process-manager/types.js';
import { makeAudit } from '../../helpers/audit.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { DEAD_PID } from '../../helpers/dead-pid.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('spawn lock vs lifecycle lock isolation (Phase 1019)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('spawn-lock-iso-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function writeLock(lockFile: string, pid: number): Promise<void> {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify({ pid }), 'utf-8');
  }

  function makeCtx(): ProcessManagerContext {
    return {
      fs: nodeFs,
      audit: makeAudit().audit,
      // 只有 FAKE_LIVE_PID 视为存活；DEAD_PID 与 process.pid 之外的均视为死
      l1IsAlive: vi.fn().mockImplementation((pid: number) => pid === FAKE_LIVE_PID),
      getProcessStartTime: vi.fn().mockReturnValue(undefined),
    };
  }

  it('live spawn lock + missing lifecycle lock → LockConflictError, spawn lock preserved', async () => {
    const clawId = `test-claw-spawn-lock-live-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const lifecycleLock = path.join(daemonDir, 'status', 'daemon.lock');
    const spawnLock = path.join(daemonDir, 'status', 'daemon.lock.spawn');
    await writeLock(spawnLock, FAKE_LIVE_PID);

    const ctx = makeCtx();
    expect(() => acquireSpawnLock(ctx, daemonDir)).toThrow(LockConflictError);

    // spawn 锁未被回收/删除
    const spawnContent = await fs.readFile(spawnLock, 'utf-8');
    expect(JSON.parse(spawnContent).pid).toBe(FAKE_LIVE_PID);
    // 生命周期锁未被创建
    expect(await fs.access(lifecycleLock).then(() => true).catch(() => false)).toBe(false);
  });

  it('live lifecycle lock + stale spawn lock → spawn lock reclaimed, lifecycle lock untouched', async () => {
    const clawId = `test-claw-spawn-lock-stale-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const lifecycleLock = path.join(daemonDir, 'status', 'daemon.lock');
    const spawnLock = path.join(daemonDir, 'status', 'daemon.lock.spawn');
    await writeLock(lifecycleLock, FAKE_LIVE_PID);
    await writeLock(spawnLock, DEAD_PID);

    const ctx = makeCtx();
    // 不抛错：stale spawn 锁被回收（修复前会误读 lifecycle 锁的活持有者而抛 LockConflictError）
    expect(() => acquireSpawnLock(ctx, daemonDir)).not.toThrow();

    // spawn 锁持有者变为本进程
    const spawnContent = await fs.readFile(spawnLock, 'utf-8');
    expect(JSON.parse(spawnContent).pid).toBe(process.pid);
    // 生命周期锁内容原样不动
    const lifecycleContent = await fs.readFile(lifecycleLock, 'utf-8');
    expect(JSON.parse(lifecycleContent).pid).toBe(FAKE_LIVE_PID);
  });
});
