/**
 * spawn 生命周期不变量（Phase 914 + Phase 1204 Step E 更新）
 *
 * 验证点：
 * 1. spawn 在 spawnDetached 成功后失败 → 子进程收到 SIGTERM（防孤儿）
 * 2. readiness 超过 30s 未就绪 → 抛出 deadline 错误并杀死子进程
 * 3. spawn 使用 generation 目录；lock/pidfile 已删除
 * 4. stop intent 在 boot 完成前可中止 spawn
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { ProcessSpawnConflictError } from '../../../src/foundation/process-manager/types.js';
import { writeActiveGenerationSync } from '../../helpers/generation-fixtures.js';
import { makeAudit } from '../../helpers/audit.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { GENERATION_FILE, PID_FILE, getSpawningDir, getStopIntentsDir, getRetiredDirFor } from '../../../src/foundation/process-manager/generation.js';

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
      isReady: () => true,
      l1IsAlive: vi.fn().mockReturnValue(true),
      kill: vi.fn(),
      spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
      getProcessStartTime: vi.fn().mockReturnValue(undefined),
      ...overrides,
    };
  }

  it('live active generation → ProcessSpawnConflictError(active_owner) with winner generation ID', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-live-active-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const winnerGeneration = 'gen-live-owner';
    writeActiveGenerationSync(daemonDir, { generationId: winnerGeneration, pid: FAKE_LIVE_PID });

    const ctx = makeCtx({ l1IsAlive: vi.fn().mockReturnValue(true) });

    const err = await spawnProcess(ctx, daemonDir, {
      command: 'node',
      args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
      logFile: path.join(daemonDir, 'logs', 'daemon.log'),
    }).catch((e) => e);

    // Phase 1235: 活 active owner 是合法竞争 —— conflict(active_owner) + 磁盘 winner ID
    expect(err).toBeInstanceOf(ProcessSpawnConflictError);
    expect(err.reason).toBe('active_owner');
    expect(err.generationId).toBe(winnerGeneration);
    expect(ctx.spawnDetached).not.toHaveBeenCalled();
  });

  it('terminates child process when spawn fails after spawnDetached', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-spawn-fail-kill-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const ctx = makeCtx({ isReady: () => false, l1IsAlive: vi.fn().mockReturnValue(false) });

    // 让 child PID 持久化失败 → 触发 cleanup kill 路径
    vi.spyOn(nodeFs, 'writeAtomicExisting').mockRejectedValue(new Error('pid fact write failed'));

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(/Cannot persist child PID/);

    expect(ctx.kill).toHaveBeenCalledWith(FAKE_LIVE_PID, 'TERM');
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

    vi.spyOn(nodeFs, 'writeAtomicExisting').mockRejectedValue(new Error('pid fact write failed'));

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(/Cannot persist child PID/);

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

    // 让 child PID 持久化失败，触发 cleanup；child 存活 → generation 保留作取证
    vi.spyOn(nodeFs, 'writeAtomicExisting').mockRejectedValue(new Error('pid fact write failed'));

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(/Cannot persist child PID/);

    // generation spawning 目录保留作取证；legacy status/pid 不存在
    expect(nodeFs.existsSync(path.join(getSpawningDir(daemonDir), GENERATION_FILE))).toBe(true);
    const legacyPidFile = path.join(daemonDir, 'status', 'pid');
    expect(await fs.access(legacyPidFile).then(() => true).catch(() => false)).toBe(false);
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

  it('aborts spawn when a stop intent for this generation is recorded before boot completes', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-stop-intent-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const killSpy = vi.fn();
    const ctx = makeCtx({
      isReady: () => false,
      l1IsAlive: vi.fn().mockReturnValue(true),
      kill: killSpy,
      // Inject a generation-bound stop intent after the spawning generation is committed
      // but before the child PID is written. This exercises the barrier between
      // writeChildPid and readiness wait.
      spawnDetached: vi.fn().mockImplementation(() => {
        const generationPath = path.join(getSpawningDir(daemonDir), GENERATION_FILE);
        const generationJson = nodeFs.readSync(generationPath);
        const generationId = (JSON.parse(generationJson) as { generation_id: string }).generation_id;
        const intentsDir = getStopIntentsDir(daemonDir);
        nodeFs.ensureDirSync(intentsDir);
        nodeFs.writeAtomicSync(
          path.join(intentsDir, 'req-1.json'),
          JSON.stringify({
            schema_version: 1,
            request_id: 'req-1',
            target_generation_id: generationId,
            observed_location: 'spawning',
            daemon_dir: daemonDir,
            created_at: new Date().toISOString(),
          }),
        );
        return { pid: FAKE_LIVE_PID };
      }),
    });

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(/stop intent/);

    expect(killSpy).toHaveBeenCalledWith(FAKE_LIVE_PID, 'TERM');
    // Spawning should have been retired by the abort path.
    expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
  });

  it('does not abort fresh spawn when a stop intent targets a previous generation', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-old-intent-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    // Pre-record a stop intent bound to a different (old) generation.
    const intentsDir = getStopIntentsDir(daemonDir);
    nodeFs.ensureDirSync(intentsDir);
    nodeFs.writeAtomicSync(
      path.join(intentsDir, 'req-old.json'),
      JSON.stringify({
        schema_version: 1,
        request_id: 'req-old',
        target_generation_id: 'old-generation-id',
        observed_location: 'spawning',
        daemon_dir: daemonDir,
        created_at: new Date().toISOString(),
      }),
    );

    const ctx = makeCtx();

    const pid = await spawnProcess(ctx, daemonDir, {
      command: 'node',
      args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
      logFile: path.join(daemonDir, 'logs', 'daemon.log'),
    });

    expect(pid).toBe(FAKE_LIVE_PID);
    expect(nodeFs.existsSync(path.join(getSpawningDir(daemonDir), GENERATION_FILE))).toBe(true);
  });

  it('aborts spawn when a stop intent arrives after commit but before child spawn', async () => {
    const { audit } = makeAudit();
    const clawId = `test-claw-stop-intent-commit-${randomUUID()}`;
    const daemonDir = testClawDaemonDir(tempDir, clawId);

    const killSpy = vi.fn();
    const ctx = makeCtx({
      isReady: () => false,
      l1IsAlive: vi.fn().mockReturnValue(true),
      kill: killSpy,
      spawnDetached: vi.fn().mockImplementation(() => {
        const generationPath = path.join(getSpawningDir(daemonDir), GENERATION_FILE);
        const generationJson = nodeFs.readSync(generationPath);
        const generationId = (JSON.parse(generationJson) as { generation_id: string }).generation_id;
        const intentsDir = getStopIntentsDir(daemonDir);
        nodeFs.ensureDirSync(intentsDir);
        nodeFs.writeAtomicSync(
          path.join(intentsDir, 'req-2.json'),
          JSON.stringify({
            schema_version: 1,
            request_id: 'req-2',
            target_generation_id: generationId,
            observed_location: 'spawning',
            daemon_dir: daemonDir,
            created_at: new Date().toISOString(),
          }),
        );
        return { pid: FAKE_LIVE_PID };
      }),
    });

    await expect(
      spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: [`/fake/daemon-entry-${randomUUID()}.js`, clawId],
        logFile: path.join(daemonDir, 'logs', 'daemon.log'),
      }),
    ).rejects.toThrow(/stop intent/);

    // In this path the child was spawned, so the abort path kills it.
    expect(killSpy).toHaveBeenCalledWith(FAKE_LIVE_PID, 'TERM');
    expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
  });
});
