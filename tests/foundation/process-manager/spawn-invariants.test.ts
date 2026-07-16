/**
 * Spawn invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - spawn.test.ts
 *  - spawn-fast-fail-child-died.test.ts
 *  - spawn-lock-isolation.test.ts
 *  - spawn-event-driven-readiness.test.ts
 *  - spawn-duration-metric.test.ts
 *  - spawn-race.test.ts
 *  - spawn-remove-pid-audit.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
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

// spawnDetached injected via ctx (phase 106 DI hygiene)

/**
 * spawn.ts — I/O error fail closed, no dual daemon (Phase 1003)
 */
describe('spawn', () => {
  describe('spawn Phase 1003 I/O fail closed', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTrackedTempDir('spawn-io-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('throws LockConflictError when pidfile read returns I/O error', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'spawn-ioerr';
      const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      await fs.writeFile(pidFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

      const ctx: ProcessManagerContext = {
        fs: nodeFs,
        audit,
        // Bypass initial alive precheck so we reach the EEXIST recovery path
        isAlive: () => false,
        isReady: () => true,
        l1IsAlive: vi.fn().mockReturnValue(false),
        spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
      };

      let writeExclusiveCallCount = 0;
      vi.spyOn(nodeFs, 'writeExclusiveSync').mockImplementation((p: string, c: string) => {
        writeExclusiveCallCount++;
        if (writeExclusiveCallCount === 1) {
          const err = new Error('EEXIST') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return (NodeFileSystem.prototype as any).writeExclusiveSync.call(nodeFs, p, c);
      });

      vi.spyOn(nodeFs, 'read').mockImplementation(async (p: string) => {
        if (p.endsWith('/pid')) {
          const err = new Error('EIO') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return (NodeFileSystem.prototype as any).read.call(nodeFs, p);
      });

      await expect(
        spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toBeInstanceOf(LockConflictError);

      expect(ctx.spawnDetached).not.toHaveBeenCalled();

      const pidReadFailed = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
      );
      expect(pidReadFailed.length).toBeGreaterThanOrEqual(1);
    });
  });
});

/**
 * spawn poll child-died fast-fail（phase 1136 / F.1，phase 1317 升级 event-driven）
 *
 * 反向 2 项：
 * 1. child 半途死 → fast-fail throw "died during boot" + < 200ms
 * 2. isReady eventually true → happy path + 0 throw
 */
describe('spawn-fast-fail-child-died', () => {
  describe('spawn poll child-died fast-fail（phase 1136 / F.1，phase 1317 升级 event-driven）', () => {
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
});

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
describe('spawn-lock-isolation', () => {
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
        // FAKE_LIVE_PID 与本进程视为存活；DEAD_PID 与其他 pid 视为死
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

      // 旧格式 spawn 锁未被回收/删除（运行中旧 daemon 继续拥有它）
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
      const spawnLockNs = `${spawnLock}-lock`;
      await writeLock(lifecycleLock, FAKE_LIVE_PID);
      await writeLock(spawnLock, DEAD_PID);

      const ctx = makeCtx();
      // 不抛错：stale spawn 锁被回收（修复前会误读 lifecycle 锁的活持有者而抛 LockConflictError）
      expect(() => acquireSpawnLock(ctx, daemonDir)).not.toThrow();

      // spawn 锁已迁移到 per-contender 协议：旧文件被删除，claims 目录下持有者是本进程
      expect(await fs.access(spawnLock).then(() => true).catch(() => false)).toBe(false);
      const claimsDir = path.join(spawnLockNs, 'claims');
      const claimNames = await fs.readdir(claimsDir);
      expect(claimNames).toHaveLength(1);
      const claimContent = await fs.readFile(path.join(claimsDir, claimNames[0]), 'utf-8');
      expect(JSON.parse(claimContent).pid).toBe(process.pid);
      // 生命周期锁内容原样不动
      const lifecycleContent = await fs.readFile(lifecycleLock, 'utf-8');
      expect(JSON.parse(lifecycleContent).pid).toBe(FAKE_LIVE_PID);
    });
  });
});

/**
 * spawn event-driven readiness（phase 1317）
 *
 * 反向 3 项：
 * 1. slow-boot (many polls) → spawn 仍成功 / 无 deadline timeout
 * 2. child crash during boot → fast-fail throw "died during boot"
 * 3. lint grep ban PROCESS_SPAWN_CONFIRM_MS in src/ and tests/
 */
describe('spawn-event-driven-readiness', () => {
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
      const testFileName = 'spawn-invariants.test.ts';
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
});

/**
 * spawn duration metric（phase 1148 / C.3）
 *
 * 反向 3 项：
 * 1. PROCESS_SPAWNED emit 含 duration_ms 非 0 col
 * 2. PROCESS_SPAWN_FAILED emit 含 duration_ms 反映 fail timing
 * 3. duration_ms 单调性（mock isReady delay 200ms）
 */
describe('spawn-duration-metric', () => {
  /**
   * isReady mock 注入 delay (ms) — 模拟真 spawn poll loop 累积时长.
   * Derivation: > eventloop tick / < 1s 不显著拖测试 / 反向 #3 mock isReady delay
   * 200ms 推出 duration_ms 下限 = poll 累积 ≥ 150ms.
   */
  const SPAWN_READY_MIN_ACCUMULATED_MS = 150;

  describe('spawn duration metric（phase 1148 / C.3）', () => {
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
});

/**
 * spawn — EEXIST race audit 归类（phase 591 / A.spawn-eexist-race-misclassify）
 *
 * 验证点：
 * 1. readSync ENOENT (race) → audit PID_READ_FAILED context=race_check / 不误归类 PID_EMPTY
 * 2. readSync 成功 + 内容空 → audit PID_EMPTY 真语义保留
 * 3. readSync 其他 IO 错（非 ENOENT）→ audit context=eexist_check + reason
 */
describe('spawn-race', () => {
  describe('spawn EEXIST race audit 归类（phase 591 / A.spawn-eexist-race-misclassify）', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTrackedTempDir('spawn-race-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    function mockWriteExclusiveOnceEEXIST(): void {
      // phase 1014/1017: spawn 先 acquireSpawnLock（writeExclusiveSync daemon.lock.spawn）再写 pid。
      // EEXIST 注入只针对 pid 文件，锁写入正常 fresh 成功（不额外产生 readSync），
      // 保持原有 readSync 调用顺序与 eexist_check 分支语义不变。
      let pidWriteAttempts = 0;
      vi.spyOn(nodeFs, 'writeExclusiveSync').mockImplementation((p: string, c: string) => {
        if (path.basename(p) === 'pid') {
          pidWriteAttempts++;
          if (pidWriteAttempts === 1) {
            const err = new Error('EEXIST') as NodeJS.ErrnoException;
            err.code = 'EEXIST';
            throw err;
          }
        }
        return (NodeFileSystem.prototype as any).writeExclusiveSync.call(nodeFs, p, c);
      });
    }

    it('readSync ENOENT (race) → audit PID_READ_FAILED context=race_check / 不误归类 PID_EMPTY', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'test-claw-race';

      const ctx: ProcessManagerContext = {
        fs: nodeFs,
        audit,
        isReady: () => true,
        l1IsAlive: vi.fn().mockReturnValue(true),
        spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
      };

      mockWriteExclusiveOnceEEXIST();
      // No readSync mock: pidFile does not exist, so readSync naturally throws
      // FileNotFoundError on the 3rd call (our code in the EEXIST branch).

      const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      });

      expect(result).toBe(FAKE_LIVE_PID);

      const pidReadFailedCalls = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
      );
      expect(pidReadFailedCalls).toHaveLength(1);
      expect(pidReadFailedCalls[0]).toEqual(
        expect.arrayContaining([
          PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
          expect.stringContaining('daemon_dir='),
          'context=race_check',
        ]),
      );

      const pidEmptyCalls = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_EMPTY,
      );
      expect(pidEmptyCalls).toHaveLength(0);
    });

    it('空 pid file → readPid corrupt + spawn fail closed', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'test-claw-empty';

      const ctx: ProcessManagerContext = {
        fs: nodeFs,
        audit,
        isReady: () => true,
        l1IsAlive: vi.fn().mockReturnValue(true),
        spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
      };

      // Pre-create empty PID file
      const pidFilePath = path.join(tempDir, 'claws', clawId, 'status', 'pid');
      await fs.mkdir(path.dirname(pidFilePath), { recursive: true });
      await fs.writeFile(pidFilePath, '   ', 'utf-8');

      mockWriteExclusiveOnceEEXIST();

      await expect(
        spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
          command: 'node',
          args: ['/fake/daemon-entry.js', clawId],
          logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
        }),
      ).rejects.toBeInstanceOf(LockConflictError);

      expect(ctx.spawnDetached).not.toHaveBeenCalled();

      const pidReadFailedCalls = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
      );
      expect(pidReadFailedCalls).toHaveLength(1);
      expect(pidReadFailedCalls[0]).toEqual(
        expect.arrayContaining([
          PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
          expect.stringContaining('daemon_dir='),
          'context=eexist_check',
          expect.stringContaining('reason='),
        ]),
      );
    });

    it('readSync 其他 IO 错（非 ENOENT）→ audit context=eexist_check + reason', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'test-claw-ioerr';

      const ctx: ProcessManagerContext = {
        fs: nodeFs,
        audit,
        isReady: () => true,
        l1IsAlive: vi.fn().mockReturnValue(true),
        spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
      };

      mockWriteExclusiveOnceEEXIST();

      // 注入 pid 文件读 IO 错：仅在第 2 次读取 pid 文件时抛 EACCES
      //（第 1 次来自初始 checkAlive，应返回 ENOENT 以继续 spawn；
      //  第 2 次来自 pid 文件 EEXIST 分支的 holder 校验）。
      const pidFilePath = path.join(tempDir, 'claws', clawId, 'status', 'pid');
      let pidFileReadCount = 0;
      vi.spyOn(nodeFs, 'readSync').mockImplementation((p: string) => {
        if (path.resolve(p) === path.resolve(pidFilePath)) {
          pidFileReadCount++;
          if (pidFileReadCount === 2) {
            const err = new Error('EACCES permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
        }
        return (NodeFileSystem.prototype as any).readSync.call(nodeFs, p);
      });

      const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      });

      expect(result).toBe(FAKE_LIVE_PID);

      const pidReadFailedCalls = events.filter(
        (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
      );
      expect(pidReadFailedCalls).toHaveLength(1);
      expect(pidReadFailedCalls[0]).toEqual(
        expect.arrayContaining([
          PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
          expect.stringContaining('daemon_dir='),
          'context=eexist_check',
          expect.stringContaining('reason='),
        ]),
      );
    });
  });
});

/**
 * spawn — removePid silent → audit (P1.1)
 *
 * 验证点：spawn retry overwrite 路径中 removePid 失败时写入 PID_REMOVE_FAILED audit
 */
describe('spawn-remove-pid-audit', () => {
  describe('spawn — removePid silent → audit (P1.1)', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      vi.restoreAllMocks();

      const { removePid } = await import('../../../src/foundation/process-manager/pid.js');
      vi.mocked(removePid).mockImplementation(async (ctx: any, _daemonDir: any, context: any) => {
        ctx.audit.write('pid_remove_failed', `daemon_dir=${_daemonDir}`, `context=${context}`, 'reason=[EACCES] EACCES permission denied');
        return false;
      });
      tempDir = await createTrackedTempDir('spawn-audit-');
      await fs.mkdir(tempDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('removePid 失败时写 PID_REMOVE_FAILED audit（不阻塞 retry overwrite）', async () => {
      const { audit, events } = makeAudit();
      const clawId = 'test-claw';

      const ctx: ProcessManagerContext = {
        fs: nodeFs,
        audit,
        isReady: () => true,
        l1IsAlive: vi.fn().mockReturnValue(true),
        spawnDetached: vi.fn().mockReturnValue({ pid: FAKE_LIVE_PID }),
      };

      // phase 1014/1017: spawn 先 acquireSpawnLock（writeExclusiveSync daemon.lock.spawn）再写 pid。
      // EEXIST 注入只针对 pid 文件，锁写入正常 fresh 成功；只统计 pid 写入次数。
      let pidWriteCount = 0;
      vi.spyOn(nodeFs, 'writeExclusiveSync').mockImplementation((p: string, c: string) => {
        if (path.basename(p) === 'pid') {
          pidWriteCount++;
          if (pidWriteCount === 1) {
            const err = new Error('EEXIST') as NodeJS.ErrnoException;
            err.code = 'EEXIST';
            throw err;
          }
        }
        return (NodeFileSystem.prototype as any).writeExclusiveSync.call(nodeFs, p, c);
      });

      const result = await spawnProcess(ctx, testClawDaemonDir(tempDir, clawId), {
        command: 'node',
        args: ['/fake/daemon-entry.js', clawId],
        logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
      });

      expect(result).toBe(FAKE_LIVE_PID);
      expect(pidWriteCount).toBe(2);

      const pidRemoveEvents = events.filter(e => e[0] === 'pid_remove_failed');
      expect(pidRemoveEvents).toHaveLength(1);
      expect(pidRemoveEvents[0]).toEqual(
        expect.arrayContaining([
          'pid_remove_failed',
          expect.stringContaining('daemon_dir='),
          'context=spawn_retry_overwrite',
          expect.stringContaining('reason=[EACCES]'),
        ]),
      );
    });
  });
});
