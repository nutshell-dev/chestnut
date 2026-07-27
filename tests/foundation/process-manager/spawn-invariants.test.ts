/**
 * Spawn invariants — Phase 1204 Step B 更新：
 *  - spawn 走 candidate → spawning 目录提交，删除 spawn lock 与 pid:0 sentinel
 *  - child PID 写入 generation 的 spawning/pid.json（existing-generation 语义）
 *  - legacy status/pid 双写作为过渡期派生 artifact（Step E 删除）
 *  - 死亡检测直探 child PID（l1IsAlive），不再经 pidfile probe
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { randomUUID } from 'crypto';
import { execSync } from 'node:child_process';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { spawnProcess } from '../../../src/foundation/process-manager/spawn.js';
import { acquireSpawnLock } from '../../../src/foundation/process-manager/lock.js';
import { makeAudit } from '../../helpers/audit.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { DEAD_PID } from '../../helpers/dead-pid.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { LockConflictError } from '../../../src/foundation/process-manager/types.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import {
  GENERATION_FILE,
  PID_FILE,
  FAILURE_FILE,
  getSpawningDir,
  getRetiredDirFor,
  getCandidateDir,
  PROCESS_GENERATION_ENV,
} from '../../../src/foundation/process-manager/generation.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0, SPAWN_POLL_INTERVAL_MS: 10 };
});

// Mock removePid to simulate failure (returns false and audits)
vi.mock('../../../src/foundation/process-manager/pid.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-manager/pid.js')>();
  return {
    ...actual,
    removePid: vi.fn().mockImplementation(async (ctx: any, _daemonDir: any, context: any) => {
      ctx.audit.write('pid_remove_failed', `daemon_dir=${_daemonDir}`, `context=${context}`, 'reason=[EACCES] EACCES permission denied');
      return false;
    }),
  };
});

function defaultCtx(
  nodeFs: NodeFileSystem,
  audit: ProcessManagerContext['audit'],
  overrides: Partial<ProcessManagerContext> = {},
): ProcessManagerContext {
  return {
    fs: nodeFs,
    audit,
    isAlive: () => false,
    isReady: () => true,
    l1IsAlive: vi.fn().mockReturnValue(true),
    spawnDetached: vi.fn().mockReturnValue({ pid: process.pid }),
    getProcessStartTime: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe('spawn', () => {
  describe('spawn generation commit fail-closed', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTrackedTempDir('spawn-gen-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('throws LockConflictError when spawning generation is malformed', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'spawn-malformed';
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      await fs.mkdir(getSpawningDir(daemonDir), { recursive: true });
      await fs.writeFile(path.join(getSpawningDir(daemonDir), GENERATION_FILE), '{not json', 'utf-8');

      const ctx = defaultCtx(nodeFs, audit);

      await expect(
        spawnProcess(ctx, daemonDir, {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toBeInstanceOf(LockConflictError);

      expect(ctx.spawnDetached).not.toHaveBeenCalled();
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED);
    });

    it('throws LockConflictError when legacy pidfile points to a live process', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'spawn-live-pid';
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

      const ctx = defaultCtx(nodeFs, audit, { isAlive: () => true });

      await expect(
        spawnProcess(ctx, daemonDir, {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toBeInstanceOf(LockConflictError);

      expect(ctx.spawnDetached).not.toHaveBeenCalled();
    });
  });

  /**
   * spawn poll child-died fast-fail
   *
   * 反向 2 项：
   * 1. child 半途死 → fast-fail throw "died during boot"
   * 2. isReady eventually true → happy path + 0 throw
   */
  describe('spawn-fast-fail-child-died', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTrackedTempDir('spawn-fast-fail-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('反向 1：child 半途死 → fast-fail throw "died during boot"', async () => {
      const { audit } = makeAudit();
      const clawId = 'test-claw-die';

      let aliveCallCount = 0;
      const ctx = defaultCtx(nodeFs, audit, {
        isAlive: () => {
          aliveCallCount++;
          // call 1 = initial entry check (must be false to proceed)
          return false;
        },
        isReady: () => false,
        // 模拟 child 在 boot 期间死掉；死亡检测直探 child PID
        l1IsAlive: vi.fn().mockReturnValue(false),
      });

      await expect(
        spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toThrow(/died during boot/);

      // Event-driven fast-fail：entry precheck 一次 isAlive，poll 不再调用 ctx.isAlive
      expect(aliveCallCount).toBe(1);
    });

    it('反向 2：isReady eventually true → happy path + 0 throw', async () => {
      const { audit } = makeAudit();
      const clawId = 'test-claw-ready';

      let readyCallCount = 0;
      const ctx = defaultCtx(nodeFs, audit, {
        isReady: () => {
          readyCallCount++;
          return readyCallCount >= 3;
        },
      });

      const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      });

      expect(result).toBe(process.pid);
    });
  });

  /**
   * spawn 锁与生命周期锁隔离反向测试（Phase 1019）
   *
   * 注意：Phase 1204 Step B 起 spawn 不再使用 spawn lock；lock.ts API 仍保留到
   * Step D/E。本段直接测试 lock.ts，保留到 lock.ts 删除为止。
   */
  describe('spawn-lock-isolation', () => {
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
        l1IsAlive: vi.fn().mockImplementation((pid: number) => pid === FAKE_LIVE_PID || pid === process.pid),
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

      const spawnContent = await fs.readFile(spawnLock, 'utf-8');
      expect(JSON.parse(spawnContent).pid).toBe(FAKE_LIVE_PID);
      expect(await fs.access(lifecycleLock).then(() => true).catch(() => false)).toBe(false);
    });

    it('live lifecycle lock + stale spawn lock → spawn lock reclaimed, lifecycle lock untouched', async () => {
      const clawId = `test-claw-spawn-lock-stale-${randomUUID()}`;
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      const lifecycleLock = path.join(daemonDir, 'status', 'daemon.lock');
      const spawnLock = path.join(daemonDir, 'status', 'daemon.lock.spawn');
      const spawnLockNs = `${spawnLock}-lock`;
      await writeLock(lifecycleLock, FAKE_LIVE_PID);
      await writeLock(spawnLock, DEAD_PID);

      const ctx = makeCtx();
      expect(() => acquireSpawnLock(ctx, daemonDir)).not.toThrow();

      expect(await fs.access(spawnLock).then(() => true).catch(() => false)).toBe(false);
      const claimsDir = path.join(spawnLockNs, 'claims');
      const claimNames = await fs.readdir(claimsDir);
      expect(claimNames).toHaveLength(1);
      const claimContent = await fs.readFile(path.join(claimsDir, claimNames[0]), 'utf-8');
      expect(JSON.parse(claimContent).pid).toBe(process.pid);
      const lifecycleContent = await fs.readFile(lifecycleLock, 'utf-8');
      expect(JSON.parse(lifecycleContent).pid).toBe(FAKE_LIVE_PID);
    });
  });

  /**
   * spawn event-driven readiness（phase 1317）
   */
  describe('spawn-event-driven-readiness', () => {
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

      let readyCallCount = 0;
      const ctx = defaultCtx(nodeFs, audit, {
        isReady: () => {
          readyCallCount++;
          return readyCallCount >= 100;
        },
      });

      const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      });

      expect(result).toBe(process.pid);
      expect(readyCallCount).toBeGreaterThanOrEqual(100);
    });

    it('l1IsAlive false → fast-fail throw "died during boot"', async () => {
      const { audit } = makeAudit();
      const clawId = 'crash-claw';

      const ctx = defaultCtx(nodeFs, audit, {
        isReady: () => false,
        l1IsAlive: vi.fn().mockReturnValue(false),
      });

      await expect(
        spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toThrow(/died during boot/);
    });

    it('grep ban PROCESS_SPAWN_CONFIRM_MS in src/ and tests/ (excluding this file)', () => {
      const testFileName = 'spawn-invariants.test.ts';
      let out = '';
      try {
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

  /**
   * spawn duration metric（phase 1148 / C.3）
   */
  describe('spawn-duration-metric', () => {
    const SPAWN_READY_MIN_ACCUMULATED_MS = 150;

    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTrackedTempDir('spawn-duration-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('反向 1：PROCESS_SPAWNED emit 含 duration_ms 非 0 col', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'test-claw';
      const ctx = defaultCtx(nodeFs, audit, { isReady: () => true });

      await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
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

      const ctx = defaultCtx(nodeFs, audit, {
        isReady: () => false,
        l1IsAlive: vi.fn().mockReturnValue(false),
      });

      const start = Date.now();
      await expect(
        spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toThrow(/died during boot/);
      const elapsed = Date.now() - start;

      const failedEvents = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
      );
      expect(failedEvents).toHaveLength(1);
      const durationCol = failedEvents[0].find((c) => typeof c === 'string' && c.startsWith('duration_ms='));
      expect(durationCol).toBeDefined();
      const durationMs = parseInt(String(durationCol).split('=')[1], 10);
      expect(durationMs).toBeGreaterThanOrEqual(0);
      expect(durationMs).toBeLessThanOrEqual(elapsed + 50);
    });

    it('反向 3：duration_ms 单调性（mock isReady delay 200ms）', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'test-claw';

      let readyCallCount = 0;
      const ctx = defaultCtx(nodeFs, audit, {
        isReady: () => {
          readyCallCount++;
          return readyCallCount >= 22;
        },
      });

      await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
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
      expect(durationMs).toBeGreaterThanOrEqual(SPAWN_READY_MIN_ACCUMULATED_MS);
    });
  });

  /**
   * Phase 1204 Step B 新增：generation 目录提交与 child env
   */
  describe('spawn-generation-commit', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTrackedTempDir('spawn-gen-commit-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('commits candidate → spawning and writes generation pid.json', async () => {
      const { audit } = makeAudit();
      const clawId = 'gen-commit';
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      const ctx = defaultCtx(nodeFs, audit, { isReady: () => true });

      const pid = await spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      });
      expect(pid).toBe(process.pid);

      const spawningDir = getSpawningDir(daemonDir);
      expect(nodeFs.existsSync(path.join(spawningDir, GENERATION_FILE))).toBe(true);
      const pidRecord = JSON.parse(nodeFs.readSync(path.join(spawningDir, PID_FILE)));
      expect(pidRecord.pid).toBe(process.pid);
      expect(pidRecord.generation_id).toBeDefined();

      // parent 不再写 pid:0 sentinel
      const legacyPidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
      const legacyContent = await fs.readFile(legacyPidFile, 'utf-8');
      expect(JSON.parse(legacyContent).pid).toBe(process.pid);
      expect(JSON.parse(legacyContent).pid).not.toBe(0);

      // candidate 目录已整体 move 走
      const candidateDirs = await fs.readdir(path.join(daemonDir, 'status', 'process', 'candidates'));
      expect(candidateDirs).toHaveLength(0);
    });

    it('passes CHESTNUT_PROCESS_GENERATION env matching generation.json', async () => {
      const { audit } = makeAudit();
      const clawId = 'gen-env';
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      const spawnDetached = vi.fn().mockReturnValue({ pid: process.pid });
      const ctx = defaultCtx(nodeFs, audit, { isReady: () => true, spawnDetached });

      await spawnProcess(ctx, daemonDir, {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      });

      const generationId = JSON.parse(nodeFs.readSync(path.join(getSpawningDir(daemonDir), GENERATION_FILE))).generation_id;
      expect(spawnDetached).toHaveBeenCalledTimes(1);
      const env = spawnDetached.mock.calls[0][2].env;
      expect(env[PROCESS_GENERATION_ENV]).toBe(generationId);
    });

    it('precheck rejects a foreign spawning generation with typed conflict', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'gen-foreign';
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      const foreignGeneration = 'gen-foreign-id';
      await fs.mkdir(getSpawningDir(daemonDir), { recursive: true });
      await fs.writeFile(
        path.join(getSpawningDir(daemonDir), GENERATION_FILE),
        JSON.stringify({
          schema_version: 1,
          generation_id: foreignGeneration,
          daemon_dir: daemonDir,
          parent_pid: 9999,
          created_at: new Date().toISOString(),
        }),
        'utf-8',
      );

      const ctx = defaultCtx(nodeFs, audit);

      await expect(
        spawnProcess(ctx, daemonDir, {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toBeInstanceOf(LockConflictError);

      expect(ctx.spawnDetached).not.toHaveBeenCalled();
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST);
    });

    it('commit race collision re-reads winner and loses without overwrite', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'gen-race';
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      const foreignGeneration = 'gen-winner';

      // 模拟并发：precheck 后另一进程先 commit，本进程 move 时 collision
      let moveCallCount = 0;
      vi.spyOn(nodeFs, 'moveSync').mockImplementation((src: string, dest: string) => {
        if (src.includes('/candidates/')) {
          moveCallCount++;
          if (moveCallCount === 1) {
            // 伪造 winner 已占 spawning
            const spawning = getSpawningDir(daemonDir);
            fsSync.mkdirSync(spawning, { recursive: true });
            fsSync.writeFileSync(
              path.join(spawning, GENERATION_FILE),
              JSON.stringify({
                schema_version: 1,
                generation_id: foreignGeneration,
                daemon_dir: daemonDir,
                parent_pid: 9999,
                created_at: new Date().toISOString(),
              }, null, 2),
              'utf-8',
            );
            const err = new Error('ENOTEMPTY') as NodeJS.ErrnoException;
            err.code = 'ENOTEMPTY';
            throw err;
          }
        }
        return (NodeFileSystem.prototype as any).moveSync.call(nodeFs, src, dest);
      });

      const ctx = defaultCtx(nodeFs, audit);

      await expect(
        spawnProcess(ctx, daemonDir, {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toBeInstanceOf(LockConflictError);

      expect(ctx.spawnDetached).not.toHaveBeenCalled();
      const spawningRecord = JSON.parse(nodeFs.readSync(path.join(getSpawningDir(daemonDir), GENERATION_FILE)));
      expect(spawningRecord.generation_id).toBe(foreignGeneration);
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST);
    });
  });

  /**
   * Phase 1204 Step B 新增：spawn 失败处置（无孤儿、无悬空 spawning）
   */
  describe('spawn-failure-disposition', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTrackedTempDir('spawn-fail-disp-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      const { removePid } = await import('../../../src/foundation/process-manager/pid.js');
      vi.mocked(removePid).mockImplementation(async (ctx: any, _daemonDir: any, context: any) => {
        ctx.audit.write('pid_remove_failed', `daemon_dir=${_daemonDir}`, `context=${context}`, 'reason=[EACCES] EACCES permission denied');
        return false;
      });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('retires spawning generation with failure fact when child dies during boot', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'fail-disposition';
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      const ctx = defaultCtx(nodeFs, audit, {
        isReady: () => false,
        l1IsAlive: vi.fn().mockReturnValue(false),
      });

      await expect(
        spawnProcess(ctx, daemonDir, {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toThrow(/died during boot/);

      expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
      // 查找 retired 目录
      const retiredRoot = path.join(daemonDir, 'status', 'process', 'retired');
      const retiredEntries = await fs.readdir(retiredRoot);
      expect(retiredEntries).toHaveLength(1);
      const retiredDir = path.join(retiredRoot, retiredEntries[0]);
      const failure = JSON.parse(nodeFs.readSync(path.join(retiredDir, FAILURE_FILE)));
      expect(failure.reason).toContain('died during boot');
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED);
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_FAILED);
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_RETIRED);
    });

    it('audits legacy removePid failure during cleanup', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'fail-remove-audit';
      const daemonDir = testClawDaemonDir(tempDir, clawId);
      const ctx = defaultCtx(nodeFs, audit, {
        isReady: () => false,
        l1IsAlive: vi.fn().mockReturnValue(false),
      });

      await expect(
        spawnProcess(ctx, daemonDir, {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toThrow(/died during boot/);

      const removeEvents = events.filter((e) => e[0] === 'pid_remove_failed');
      expect(removeEvents).toHaveLength(1);
      expect(removeEvents[0]).toEqual(
        expect.arrayContaining(['pid_remove_failed', expect.stringContaining('daemon_dir='), 'context=spawn_cleanup']),
      );
    });
  });
});
