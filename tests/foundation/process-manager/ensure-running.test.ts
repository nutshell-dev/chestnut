/**
 * ensureRunning invariants — Phase 1282 Step A：
 *  - already_ready：active generation ready + 进程存活 → 不 spawn
 *  - spawned：无 winner → 本方 spawn 成功
 *  - joined：三种合法 conflict（active_owner / spawn_in_progress / commit_lost）
 *    等待 exact foreign winner 至 ready，不自行二次 spawn
 *  - typed convergence failure：winner_died / winner_failed / winner_retired /
 *    winner_replaced / winner_vanished，均携带 expected generation
 *  - malformed 持久状态沿 ProcessGenerationStateError fail-closed，不降级为 conflict
 *  - 两个并发 ensureRunning 恰一 spawn 一 join
 *  - join 审计带 expected generation（ENSURE_JOINED / ENSURE_FAILED）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { ensureRunning } from '../../../src/foundation/process-manager/ensure-running.js';
import {
  activateGeneration,
  writeReadyFact,
  newProcessGeneration,
  inspectSpawning,
  FAILURE_FILE,
  READY_FILE,
  getActiveDir,
  getSpawningDir,
  getRetiredDirFor,
} from '../../../src/foundation/process-manager/generation.js';
import { makeAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { BOOT_DEADLINE_MS } from '../../../src/foundation/process-manager/constants.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import {
  ProcessGenerationStateError,
  ProcessSpawnConflictError,
  ProcessWinnerConvergenceError,
} from '../../../src/foundation/process-manager/types.js';
import type { ProcessManagerContext, SpawnOptions } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import {
  writeActiveGenerationSync,
  writeSpawningGenerationSync,
} from '../../helpers/generation-fixtures.js';
import type { DaemonDir } from '../../../src/foundation/process-manager/index.js';

// Mock constants to eliminate sleep delays
// Phase 1303：BOOT_DEADLINE_MS 从 30s 缩到 500ms —— fake timers 推进 deadline +
// 100ms 时 poll 轮数 3100 → 60，消除 join 每轮 4 次真实磁盘读（含 3 次 ENOENT）
// 在全量并行负载下超 15s testTimeout 的 flaky。判定逻辑不变、只缩短时间尺度。
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    DAEMON_SHUTDOWN_GRACE_MS: 0,
    SPAWN_POLL_INTERVAL_MS: 10,
    BOOT_DEADLINE_MS: 500,
  };
});

// Phase 1282 Step C：call-through 包装共享等待原语，断言 self-winner（spawn）与
// foreign-winner（join）都消费同一 awaitReadyConvergence，不再各自维护循环。
const h = vi.hoisted(() => ({ convergenceCalls: 0 }));
vi.mock('../../../src/foundation/process-manager/ready-convergence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-manager/ready-convergence.js')>();
  return {
    ...actual,
    // Phase 1303：BOOT_DEADLINE_MS 覆盖移入 constants.js mock（模块内部 const
    // 闭包不可被导出 mock 替换，数值须经跨模块导入绑定覆盖）
    awaitReadyConvergence: (...args: Parameters<typeof actual.awaitReadyConvergence>) => {
      h.convergenceCalls++;
      return actual.awaitReadyConvergence(...args);
    },
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

function spawnOptionsFor(tempDir: string, clawId: string): SpawnOptions {
  return {
    command: 'node',
    args: ['/fake/daemon-entry.js', clawId],
    logFile: path.join(tempDir, 'claws', clawId, 'logs', 'daemon.log'),
  };
}

async function writeFailureFactSync(daemonDir: DaemonDir, generationId: string, reason: string): Promise<void> {
  await fs.writeFile(
    path.join(getSpawningDir(daemonDir), FAILURE_FILE),
    JSON.stringify({
      schema_version: 1,
      generation_id: generationId,
      reason,
      created_at: new Date().toISOString(),
    }),
    'utf-8',
  );
}

/** winner child 行为：写 ready 事实后将 spawning 整体 move 到 active。 */
async function activateWinnerFromSpawning(daemonDir: DaemonDir): Promise<void> {
  await fs.rename(getSpawningDir(daemonDir), getActiveDir(daemonDir));
}

describe('ensureRunning', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    h.convergenceCalls = 0;
    tempDir = await createTrackedTempDir('ensure-running-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('returns already_ready when active generation is ready and alive (no spawn)', async () => {
    const { audit } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-already-ready');
    const generationId = randomUUID();
    writeActiveGenerationSync(daemonDir, { generationId, pid: process.pid });

    const ctx = defaultCtx(nodeFs, audit);
    const outcome = await ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-already-ready'));

    expect(outcome).toEqual({ kind: 'already_ready', pid: process.pid });
    expect(ctx.spawnDetached).not.toHaveBeenCalled();
  });

  it('returns spawned when no winner exists', async () => {
    const { audit } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-spawned');

    const ctx = defaultCtx(nodeFs, audit);
    const outcome = await ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-spawned'));

    expect(outcome).toEqual({ kind: 'spawned', pid: process.pid });
    expect(ctx.spawnDetached).toHaveBeenCalledTimes(1);
    // self-winner readiness 走共享原语恰好一次
    expect(h.convergenceCalls).toBe(1);
  });

  it('joins active_owner winner once it writes ready (no second spawn)', async () => {
    const { audit } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-join-active-owner');
    const generationId = randomUUID();
    // active owner 存活但尚未 ready：precheck 不判 already_ready，spawn 抛 active_owner
    const dir = getActiveDir(daemonDir);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, 'generation.json'), JSON.stringify({
      schema_version: 1, generation_id: generationId, daemon_dir: daemonDir,
      parent_pid: process.pid, created_at: new Date().toISOString(),
    }), 'utf-8');
    fsSync.writeFileSync(path.join(dir, 'pid.json'), JSON.stringify({
      schema_version: 1, generation_id: generationId, pid: process.pid,
      created_at: new Date().toISOString(),
    }), 'utf-8');

    // spawn 的 active precheck 首次 liveness 探测时由「winner child」补上 ready 事实 —
    // 保证 join 启动时 winner 尚未 ready，走真实 convergence 而非 already_ready。
    const realL1 = vi.fn().mockImplementation(() => {
      if (!fsSync.existsSync(path.join(dir, READY_FILE))) {
        fsSync.writeFileSync(path.join(dir, READY_FILE), JSON.stringify({
          schema_version: 1, generation_id: generationId, pid: process.pid,
          created_at: new Date().toISOString(),
        }), 'utf-8');
      }
      return true;
    });
    const ctx = defaultCtx(nodeFs, audit, { l1IsAlive: realL1 });

    const outcome = await ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-join-active-owner'));

    expect(outcome).toEqual({ kind: 'joined', pid: process.pid, generationId });
    expect(ctx.spawnDetached).not.toHaveBeenCalled();
  });

  it('joins spawn_in_progress winner through spawning → active convergence', async () => {
    const { audit, events, emitter } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-join-spawning');
    const generationId = randomUUID();
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });

    const ctx = defaultCtx(nodeFs, audit);
    const promise = ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-join-spawning'));

    // spawn precheck 已对 foreign spawning 写 commit_lost 审计 → join 已开始轮询
    await waitForAuditEvent(emitter, events, PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST, 5000);
    // winner child 写 ready 事实并 activate
    // Phase 1299：与 production writeReadyFact 同协议原子写（temp+rename），
    // 消除 join 轮询读到写入中间态误判 malformed 的 flaky 窗口
    await nodeFs.writeAtomicExisting(
      path.join(getSpawningDir(daemonDir), READY_FILE),
      JSON.stringify({
        schema_version: 1, generation_id: generationId, pid: process.pid,
        created_at: new Date().toISOString(),
      }),
    );
    await activateWinnerFromSpawning(daemonDir);

    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'joined', pid: process.pid, generationId });
    expect(ctx.spawnDetached).not.toHaveBeenCalled();
    // foreign-winner join 走同一共享原语恰好一次（spawn 在 precheck 即 conflict、未进 readiness）
    expect(h.convergenceCalls).toBe(1);

    // join 审计带 expected generation
    const joined = events.find((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.ENSURE_JOINED);
    expect(joined).toBeDefined();
    expect(joined).toContain(`generation=${generationId}`);
  });

  it('joins commit_lost winner and never follows a different generation', async () => {
    const { audit, events, emitter } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-join-commit-lost');
    const generationId = randomUUID();

    // candidate → spawning commit 的 moveDirSync 前注入 foreign winner ——
    // prepare/commit 是同步段，audit gate 无法在两者之间插入；hook moveDirSync 确定性制造 commit_lost。
    let injected = false;
    const fsProxy = new Proxy(nodeFs, {
      get(target, prop, receiver) {
        if (prop === 'moveDirSync') {
          return (src: string, dest: string) => {
            if (!injected && src.includes('candidates')) {
              injected = true;
              writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });
            }
            return target.moveSync(src, dest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    const ctx = defaultCtx(fsProxy as NodeFileSystem, audit);
    const promise = ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-join-commit-lost'));

    // commit collision 已重读 winner 并写 commit_lost 审计 → join 已开始轮询
    await waitForAuditEvent(emitter, events, PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST, 5000);
    expect(injected).toBe(true);
    // Phase 1299：同 production writeReadyFact 原子写协议，防 join 轮询 partial-read
    await nodeFs.writeAtomicExisting(
      path.join(getSpawningDir(daemonDir), READY_FILE),
      JSON.stringify({
        schema_version: 1, generation_id: generationId, pid: process.pid,
        created_at: new Date().toISOString(),
      }),
    );
    await activateWinnerFromSpawning(daemonDir);

    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'joined', pid: process.pid, generationId });
    expect(ctx.spawnDetached).not.toHaveBeenCalled();
  });

  it('fails winner_died when spawning winner wrote ready but process is dead', async () => {
    const { audit, events } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-winner-died');
    const generationId = randomUUID();
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });
    await fs.writeFile(path.join(getSpawningDir(daemonDir), READY_FILE), JSON.stringify({
      schema_version: 1, generation_id: generationId, pid: process.pid,
      created_at: new Date().toISOString(),
    }), 'utf-8');

    const ctx = defaultCtx(nodeFs, audit, { l1IsAlive: vi.fn().mockReturnValue(false) });
    const err = await ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-winner-died')).catch((e) => e);

    expect(err).toBeInstanceOf(ProcessWinnerConvergenceError);
    expect(err).not.toBeInstanceOf(ProcessSpawnConflictError);
    expect(err.reason).toBe('winner_died');
    expect(err.generationId).toBe(generationId);
    expect(events.some((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.ENSURE_FAILED)).toBe(true);
  });

  it('fails winner_failed with preserved reason when winner records failure fact', async () => {
    const { audit } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-winner-failed');
    const generationId = randomUUID();
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });
    await writeFailureFactSync(daemonDir, generationId, 'child boot exploded');

    const ctx = defaultCtx(nodeFs, audit);
    const err = await ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-winner-failed')).catch((e) => e);

    expect(err).toBeInstanceOf(ProcessWinnerConvergenceError);
    expect(err.reason).toBe('winner_failed');
    expect(err.generationId).toBe(generationId);
    expect(err.message).toContain('child boot exploded');
  });

  it('fails winner_failed when generation is retired carrying a failure fact', async () => {
    const { audit, events, emitter } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-retired-failed');
    const generationId = randomUUID();
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });
    await writeFailureFactSync(daemonDir, generationId, 'died during boot');

    const ctx = defaultCtx(nodeFs, audit);
    const promise = ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-retired-failed')).catch((e) => e);

    await waitForAuditEvent(emitter, events, PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST, 5000);
    await fs.mkdir(path.dirname(getRetiredDirFor(daemonDir, generationId)), { recursive: true });
    await fs.rename(getSpawningDir(daemonDir), getRetiredDirFor(daemonDir, generationId));

    const err = await promise;
    expect(err).toBeInstanceOf(ProcessWinnerConvergenceError);
    expect(err.reason).toBe('winner_failed');
    expect(err.message).toContain('died during boot');
  });

  it('fails winner_retired when generation is retired without failure fact', async () => {
    const { audit, events, emitter } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-winner-retired');
    const generationId = randomUUID();
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });

    const ctx = defaultCtx(nodeFs, audit);
    const promise = ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-winner-retired')).catch((e) => e);

    await waitForAuditEvent(emitter, events, PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST, 5000);
    await fs.mkdir(path.dirname(getRetiredDirFor(daemonDir, generationId)), { recursive: true });
    await fs.rename(getSpawningDir(daemonDir), getRetiredDirFor(daemonDir, generationId));

    const err = await promise;
    expect(err).toBeInstanceOf(ProcessWinnerConvergenceError);
    expect(err.reason).toBe('winner_retired');
    expect(err.generationId).toBe(generationId);
  });

  it('fails winner_replaced when a different generation takes the active slot', async () => {
    const { audit, events, emitter } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-winner-replaced');
    const generationId = randomUUID();
    const otherGenerationId = randomUUID();
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });

    const ctx = defaultCtx(nodeFs, audit);
    const promise = ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-winner-replaced')).catch((e) => e);

    await waitForAuditEvent(emitter, events, PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST, 5000);
    writeActiveGenerationSync(daemonDir, { generationId: otherGenerationId, pid: process.pid });
    await fs.rm(getSpawningDir(daemonDir), { recursive: true, force: true });

    const err = await promise;
    expect(err).toBeInstanceOf(ProcessWinnerConvergenceError);
    expect(err.reason).toBe('winner_replaced');
    expect(err.generationId).toBe(generationId);
  });

  it('fails winner_vanished when generation disappears from all slots', async () => {
    const { audit, events, emitter } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-winner-vanished');
    const generationId = randomUUID();
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });

    const ctx = defaultCtx(nodeFs, audit);
    const promise = ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-winner-vanished')).catch((e) => e);

    await waitForAuditEvent(emitter, events, PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST, 5000);
    await fs.rm(getSpawningDir(daemonDir), { recursive: true, force: true });

    const err = await promise;
    expect(err).toBeInstanceOf(ProcessWinnerConvergenceError);
    expect(err.reason).toBe('winner_vanished');
    expect(err.generationId).toBe(generationId);
  });

  it('propagates ProcessGenerationStateError when spawning turns malformed during join', async () => {
    const { audit, events, emitter } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-join-malformed');
    const generationId = randomUUID();
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });

    const ctx = defaultCtx(nodeFs, audit);
    const promise = ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-join-malformed')).catch((e) => e);

    await waitForAuditEvent(emitter, events, PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST, 5000);
    await fs.writeFile(path.join(getSpawningDir(daemonDir), 'generation.json'), '{not json', 'utf-8');

    const err = await promise;
    expect(err).toBeInstanceOf(ProcessGenerationStateError);
    expect(err).not.toBeInstanceOf(ProcessWinnerConvergenceError);
    expect(err.location).toBe('spawning');
  });

  it('fails join_timeout via shared deadline when winner never becomes ready', async () => {
    const { audit, events } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-join-timeout');
    const generationId = randomUUID();
    // winner 持有 spawning、进程存活但永不写 ready → 只能由共享 deadline 终止
    writeSpawningGenerationSync(daemonDir, { generationId, pid: process.pid });

    vi.useFakeTimers();
    // 共享原语 deadline = BOOT_DEADLINE_MS（本文件 mock 为 500ms）；poll 由本文件 mock 为 10ms
    const ADVANCE_PAST_DEADLINE_MS = BOOT_DEADLINE_MS + 100; // 略超 deadline，保证 timeout 分支触发
    try {
      const ctx = defaultCtx(nodeFs, audit);
      const promise = ensureRunning(ctx, daemonDir, spawnOptionsFor(tempDir, 'ensure-join-timeout')).catch((e) => e);

      await vi.advanceTimersByTimeAsync(ADVANCE_PAST_DEADLINE_MS);

      const err = await promise;
      expect(err).toBeInstanceOf(ProcessWinnerConvergenceError);
      expect(err.reason).toBe('join_timeout');
      expect(err.generationId).toBe(generationId);
      const failed = events.find((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.ENSURE_FAILED);
      expect(failed).toBeDefined();
      expect(failed).toContain('reason=join_timeout');
      expect(failed).toContain(`generation=${generationId}`);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('two concurrent ensureRunning: exactly one spawned, one joined with the winner generation', async () => {
    const { audit: auditA } = makeAudit();
    const { audit: auditB } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'ensure-concurrent');

    const ctxA = defaultCtx(nodeFs, auditA);
    const ctxB = defaultCtx(nodeFs, auditB);
    const options = spawnOptionsFor(tempDir, 'ensure-concurrent');

    const promiseA = ensureRunning(ctxA, daemonDir, options);
    const promiseB = ensureRunning(ctxB, daemonDir, options);

    // 等 winner 提交 spawning 并写入 child PID（spawn  readiness loop 前）
    const deadline = Date.now() + 5000;
    const POLL_MS = 5; // 磁盘事实轮询间隔：远小于 spawn readiness loop、保证 join 已进入等待
    for (;;) {
      const pidPath = path.join(getSpawningDir(daemonDir), 'pid.json');
      if (fsSync.existsSync(pidPath)) break;
      if (Date.now() > deadline) throw new Error('timeout waiting for winner spawning pid');
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    const inspection = inspectSpawning(ctxA, daemonDir);
    expect(inspection.status).toBe('ok');
    if (inspection.status !== 'ok') throw new Error('unreachable');
    const winnerGenerationId = inspection.record.generation_id;

    // winner child（真实协议函数）写 ready 事实并 activate
    const record = newProcessGeneration(ctxA, daemonDir);
    record.generation_id = winnerGenerationId;
    expect((await writeReadyFact(ctxA, record, process.pid)).kind).toBe('written');
    const activation = activateGeneration(ctxA, daemonDir, { generationId: winnerGenerationId, pid: process.pid });
    expect(activation.kind).toBe('activated');

    const [outcomeA, outcomeB] = await Promise.all([promiseA, promiseB]);
    const kinds = [outcomeA.kind, outcomeB.kind].sort();
    expect(kinds).toEqual(['joined', 'spawned']);
    const joined = [outcomeA, outcomeB].find((o) => o.kind === 'joined');
    expect(joined).toMatchObject({ kind: 'joined', pid: process.pid, generationId: winnerGenerationId });
    // winner spawn readiness + loser join 各消费共享原语一次
    expect(h.convergenceCalls).toBe(2);
  });
});
