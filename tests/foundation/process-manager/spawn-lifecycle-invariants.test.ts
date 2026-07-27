/**
 * spawn 生命周期不变量（Phase 914 + Phase 1204 Step B 更新）
 *
 * 验证点：
 * 1. cleanupLock 遇到活 holder → LockConflictError，不发送 SIGTERM
 * 2. acquireLock 写入的 lock 文件包含 startTime
 * 3. spawn 在 spawnDetached 成功后失败 → 子进程收到 SIGTERM（防孤儿）
 * 4. readiness 超过 30s 未就绪 → 抛出 deadline 错误并杀死子进程
 * 5. spawn 不再使用 spawn lock；生成 generation 目录而非 pid:0 sentinel
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { acquireLock, readLockPid } from '../../../src/foundation/process-manager/lock.js';
import { getLockFile, getPidFile } from '../../../src/foundation/process-manager/paths.js';
import { LockConflictError } from '../../../src/foundation/process-manager/types.js';
import { makeAudit } from '../../helpers/audit.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { GENERATION_FILE, PID_FILE, getSpawningDir } from '../../../src/foundation/process-manager/generation.js';

// 压缩测试中的 sleep 间隔；DAEMON_SHUTDOWN_GRACE_MS=0 让 kill 路径立即返回
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 10 };
});

describe('spawn lifecycle invariants (Phase 914 / 1204 Step B)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('spawn-inv-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCtx(overrides: Partial<ProcessManagerContext> = {}): ProcessManagerContext {
    return {
      fs: nodeFs,
      audit: makeAudit().audit,
      isAlive: () => false,
      isReady: () => true,
      l1IsAlive: vi.fn().mockReturnValue(true),
      kill: vi.fn(),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
      getProcessStartTime: vi.fn().mockReturnValue(undefined),
      ...overrides,
    };
  }

  it('cleanupLock throws LockConflictError when lock holder is alive (no SIGTERM)', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-lock-live-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const lockFile = path.join(daemonDir, 'status', 'daemon.lock');
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(
      lockFile,
      JSON.stringify({ pid: FAKE_LIVE_PID, startTime: 'Sat May 18 10:30:00 2026' }),
      'utf-8',
    );

    const ctx = makeCtx();

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toBeInstanceOf(LockConflictError);

    expect(ctx.kill).not.toHaveBeenCalled();
  });

  it('acquireLock writes startTime in lock file', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-lock-starttime-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const ctx: ProcessManagerContext = {
      fs: nodeFs,
      audit,
      l1IsAlive: () => true,
      getProcessStartTime: vi.fn().mockReturnValue('Sat May 18 10:30:00 2026'),
    };

    acquireLock(ctx, daemonDir);

    const holder = readLockPid(ctx, daemonDir);
    expect(holder).not.toBeNull();
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.startTime).toBe('Sat May 18 10:30:00 2026');
  });

  it('terminates child process when spawn fails after spawnDetached', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-spawn-fail-kill-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const ctx = makeCtx({ isReady: () => false, l1IsAlive: vi.fn().mockReturnValue(false) });

    // 让 legacy status/pid 双写失败 → 触发 cleanup kill 路径
    vi.spyOn(nodeFs, 'writeAtomic').mockRejectedValue(new Error('pidfile write failed'));

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow('pidfile write failed');

    expect(ctx.kill).toHaveBeenCalledWith(FAKE_LIVE_PID, 'TERM');
  });

  it('does not delete corrupt lock file', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-lock-corrupt-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const lockFile = getLockFile({ fs: nodeFs } as ProcessManagerContext, daemonDir);
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, 'this is not valid lock content', 'utf-8');

    const ctx = makeCtx({ isReady: () => false, l1IsAlive: vi.fn().mockReturnValue(false) });

    // corrupt lock should not prevent spawn; lock file must remain untouched
    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow();

    expect(await fs.access(lockFile).then(() => true).catch(() => false)).toBe(true);
  });

  it('uses childStartTime in isAlive check during spawn cleanup', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-spawn-starttime-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const childStartTime = 'Sat May 18 10:30:00 2026';

    const l1IsAliveSpy = vi.fn().mockReturnValue(false);
    const ctx = makeCtx({
      isReady: () => false,
      l1IsAlive: l1IsAliveSpy,
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
      getProcessStartTime: vi.fn().mockReturnValue(childStartTime),
    });

    vi.spyOn(nodeFs, 'writeAtomic').mockRejectedValue(new Error('pidfile write failed'));

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow('pidfile write failed');

    expect(l1IsAliveSpy).toHaveBeenCalledWith(FAKE_LIVE_PID, childStartTime);
  });

  it('keeps generation state when child survives kill attempts', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-child-survives-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const ctx = makeCtx({
      isReady: () => false,
      l1IsAlive: vi.fn().mockReturnValue(true), // child survives everything
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    });

    // 让 legacy status/pid 双写失败，触发 cleanup；child 存活 → generation 保留作取证
    vi.spyOn(nodeFs, 'writeAtomic').mockRejectedValue(new Error('pidfile write failed'));

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow('pidfile write failed');

    // 旧的 status/pid 未写入；generation spawning 目录保留（含 pid.json）
    expect(nodeFs.existsSync(path.join(getSpawningDir(daemonDir), GENERATION_FILE))).toBe(true);
    expect(nodeFs.existsSync(path.join(getSpawningDir(daemonDir), PID_FILE))).toBe(true);
    const pidFile = getPidFile({ fs: nodeFs } as ProcessManagerContext, daemonDir);
    expect(await fs.access(pidFile).then(() => true).catch(() => false)).toBe(false);
  });

  it('spawn creates spawning generation and never creates spawn lock artifact', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-spawn-lock-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const spawnLock = path.join(daemonDir, 'status', 'daemon.lock.spawn');

    const ctx = makeCtx();

    const pid = await spawnProcess(ctx, daemonDir, {
      command: 'node',
      args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
      logFile: path.join(daemonDir, 'logs', 'daemon.log'),
    });

    expect(pid).toBe(FAKE_LIVE_PID);
    // 生命周期锁与 spawn 锁均未被创建
    expect(await fs.access(path.join(daemonDir, 'status', 'daemon.lock')).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(spawnLock).then(() => true).catch(() => false)).toBe(false);
    // generation spawning 目录存在
    expect(nodeFs.existsSync(path.join(getSpawningDir(daemonDir), GENERATION_FILE))).toBe(true);
    expect(nodeFs.existsSync(path.join(getSpawningDir(daemonDir), PID_FILE))).toBe(true);
  });

  it('throws when daemon does not become ready within deadline and kills child', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-ready-deadline-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const killSpy = vi.fn();
    const ctx = makeCtx({
      isReady: () => false,
      l1IsAlive: vi.fn().mockReturnValue(true),
      kill: killSpy,
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
    });

    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValue(1000 + 35_000);

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(/did not become ready within/);

    expect(killSpy).toHaveBeenCalledWith(FAKE_LIVE_PID, 'TERM');
    expect(killSpy).toHaveBeenCalledWith(FAKE_LIVE_PID, 'KILL');

    nowSpy.mockRestore();
  });
});
