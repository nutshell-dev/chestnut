/**
 * Phase 1396 Step F: Watchdog executor recovery tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { maybeCronExecutorRecovery, EXECUTOR_RECOVERY_EVIDENCE_DIR } from '../../src/watchdog/executor-recovery.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { _resetWatchdogContextForTest, type ExecutorRestartMap } from '../../src/watchdog/watchdog-context.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';
import type { ExecutionFailureSink } from '../../src/core/contract/index.js';

const TIME_BASE = 1_700_000_000_000;
const CLAW = 'test-claw';

function makeMockAudit() {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => entries.push([type, ...cols]),
  };
}

function makeMockPm(overrides?: Partial<ProcessManager>): ProcessManager {
  return {
    getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'no active generation' }),
    spawn: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    isAlive: vi.fn(),
    kill: vi.fn(),
    ...overrides,
  } as unknown as ProcessManager;
}

describe('maybeCronExecutorRecovery', () => {
  let rootDir: string;
  let fsFactory: (baseDir: string) => NodeFileSystem;
  let audit: ReturnType<typeof makeMockAudit>;
  let pm: ProcessManager;
  let spawnDaemon: ReturnType<typeof vi.fn>;
  let makeFailureSink: ReturnType<typeof vi.fn>;
  let now: ReturnType<typeof vi.fn>;

  const originalChestnutRoot = process.env.CHESTNUT_ROOT;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    rootDir = path.join(os.tmpdir(), `watchdog-executor-recovery-${randomUUID()}`);
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(path.join(rootDir, '.chestnut', 'claws', CLAW), { recursive: true });
    process.env.CHESTNUT_ROOT = rootDir;
    fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
    audit = makeMockAudit();
    spawnDaemon = vi.fn();
    makeFailureSink = vi.fn();
    now = vi.fn().mockReturnValue(TIME_BASE);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env.CHESTNUT_ROOT = originalChestnutRoot;
  });

  function evidencePath(rawClawId: string): string {
    return path.join(rootDir, '.chestnut', EXECUTOR_RECOVERY_EVIDENCE_DIR, `${rawClawId}.json`);
  }

  function readEvidence(rawClawId: string) {
    const p = evidencePath(rawClawId);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  }

  function run(stateMap: Record<string, any> = {}) {
    return maybeCronExecutorRecovery(stateMap, {
      pm,
      audit,
      fsFactory,
      daemonLogName: 'daemon.log',
      spawnDaemon,
      makeFailureSink,
      now,
      baseIntervalMs: 1000,
      maxBackoffMs: 60_000,
      maxAttempts: 3,
    });
  }

  it('dead claw with active generation pid → spawn restart, state retrying', async () => {
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'PID 123 not alive', pid: 123 }) });
    spawnDaemon.mockResolvedValue({ kind: 'spawned', pid: 456 });
    const next = await run();
    expect(spawnDaemon).toHaveBeenCalledWith(CLAW);
    expect(next[CLAW].status).toBe('retrying');
    expect(next[CLAW].awaitingStability).toBe(true);
  });

  it('alive claw → clear state + delete evidence', async () => {
    fs.mkdirSync(path.dirname(evidencePath(CLAW)), { recursive: true });
    fs.writeFileSync(evidencePath(CLAW), JSON.stringify({ schema_version: 1, executorId: CLAW, consecutiveAttempts: 3, openedAt: TIME_BASE - 1000 }));
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: true, reason: 'PID 123', pid: 123 }) });
    const prior = { [CLAW]: { status: 'open', consecutiveAttempts: 3, openedAt: TIME_BASE - 1000 } };
    const next = await run(prior);
    expect(next[CLAW]).toBeUndefined();
    expect(readEvidence(CLAW)).toBeNull();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.WATCHDOG_CIRCUIT_REOPENED)).toBe(true);
  });

  it('clean-stop marker → no restart, state cleared', async () => {
    fs.writeFileSync(path.join(rootDir, '.chestnut', 'claws', CLAW, 'clean-stop'), '123');
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'PID 123 not alive', pid: 123 }) });
    const prior = { [CLAW]: { status: 'retrying', consecutiveAttempts: 1, nextAttemptAt: TIME_BASE - 1 } };
    const next = await run(prior);
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(next[CLAW]).toBeUndefined();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_RECOVERY_SKIPPED)).toBe(true);
  });

  it('no active generation (never started) → no restart', async () => {
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'no active generation' }) });
    const next = await run();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(next[CLAW]).toBeUndefined();
  });

  it('spawn conflict → reset to closed, no attempts', async () => {
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'PID 123 not alive', pid: 123 }) });
    spawnDaemon.mockResolvedValue({ kind: 'spawn_conflict', reason: 'already_spawning' });
    const next = await run();
    expect(next[CLAW]).toBeUndefined();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED)).toBe(true);
  });

  it('spawn failure → retrying with attempts + defer', async () => {
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'PID 123 not alive', pid: 123 }) });
    spawnDaemon.mockRejectedValue(new Error('spawn failed'));
    let next = await run();
    expect(next[CLAW].status).toBe('retrying');
    expect(next[CLAW].consecutiveAttempts).toBe(1);

    // 立即重调仍在 defer 窗口内 → 不 increment
    now.mockReturnValue(TIME_BASE + 1);
    next = await run(next);
    expect(next[CLAW].consecutiveAttempts).toBe(1);
    expect(spawnDaemon).toHaveBeenCalledTimes(1);

    // 超过 defer 窗口 → attempt 2
    now.mockReturnValue(next[CLAW].nextAttemptAt! + 1);
    spawnDaemon.mockRejectedValue(new Error('spawn failed again'));
    next = await run(next);
    expect(next[CLAW].consecutiveAttempts).toBe(2);
  });

  it('attempts exhausted → circuit open + terminal evidence + sink.report', async () => {
    const sinkReport = vi.fn().mockResolvedValue([{ kind: 'committed' }]);
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'PID 123 not alive', pid: 123 }) });
    spawnDaemon.mockRejectedValue(new Error('fail'));

    let next: any = {};
    for (let i = 0; i < 4; i++) {
      now.mockReturnValue(TIME_BASE + i * 100_000);
      next = await run(next);
    }

    expect(next[CLAW].status).toBe('open');
    expect(next[CLAW].sinkDelivered).toBe(true);
    const evidence = readEvidence(CLAW);
    expect(evidence).toMatchObject({ schema_version: 1, executorId: CLAW, consecutiveAttempts: 3, sinkDelivered: true });
    expect(sinkReport).toHaveBeenCalledTimes(1);
    expect(sinkReport).toHaveBeenCalledWith({
      executorId: CLAW,
      producer: 'watchdog',
      reason: 'daemon_unavailable',
      evidenceRef: `${EXECUTOR_RECOVERY_EVIDENCE_DIR}/${CLAW}.json`,
    });
  });

  it('sink throws → evidence retained + delivery retried next tick', async () => {
    const sinkReport = vi.fn().mockRejectedValueOnce(new Error('contract fs down'));
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'PID 123 not alive', pid: 123 }) });
    spawnDaemon.mockRejectedValue(new Error('fail'));

    let next: any = {};
    for (let i = 0; i < 4; i++) {
      now.mockReturnValue(TIME_BASE + i * 100_000);
      next = await run(next);
    }
    expect(sinkReport).toHaveBeenCalledTimes(1);
    expect(next[CLAW].sinkDelivered).toBeFalsy();
    expect(readEvidence(CLAW)).not.toBeNull();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_UNAVAILABLE_DELIVERY_FAILED)).toBe(true);

    // 下一 tick 仍 circuit-open → 重试交付（不重复 spawn）
    now.mockReturnValue(TIME_BASE + 500_000);
    sinkReport.mockResolvedValue([{ kind: 'committed' }]);
    next = await run(next);
    expect(sinkReport).toHaveBeenCalledTimes(2);
    expect(next[CLAW].sinkDelivered).toBe(true);
  });

  it('sink returns retryable_failure → evidence retained + delivery retried', async () => {
    const sinkReport = vi.fn().mockResolvedValue([{ kind: 'retryable_failure' }]);
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'PID 123 not alive', pid: 123 }) });
    spawnDaemon.mockRejectedValue(new Error('fail'));

    let next: any = {};
    for (let i = 0; i < 4; i++) {
      now.mockReturnValue(TIME_BASE + i * 100_000);
      next = await run(next);
    }
    expect(next[CLAW]).toBeDefined();
    expect(next[CLAW].sinkDelivered).toBeFalsy();
    now.mockReturnValue(TIME_BASE + 500_000);
    sinkReport.mockResolvedValue([{ kind: 'committed' }]);
    next = await run(next);
    expect(next[CLAW].sinkDelivered).toBe(true);
  });
});
