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
import { absentLiveness, aliveLiveness, deadLiveness } from '../helpers/liveness-fixtures.js';

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
    liveness: vi.fn().mockReturnValue(absentLiveness('missing_active')),
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
      spawnDaemon,
      makeFailureSink,
      now,
      baseIntervalMs: 1000,
      maxBackoffMs: 60_000,
      maxAttempts: 3,
      heartbeatStaleTimeoutMs: 180_000,
    });
  }

  /** Phase 1878 Step B: 写 daemon 心跳事实（协议面 = <clawDir>/daemon/heartbeat.json）。 */
  function writeHeartbeat(rawClawId: string, ts: number) {
    const p = path.join(rootDir, '.chestnut', 'claws', rawClawId, 'daemon', 'heartbeat.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ schema_version: 1, ts, pid: 123 }));
  }

  it('dead claw with active generation pid → spawn restart, state retrying', async () => {
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
    spawnDaemon.mockResolvedValue({ kind: 'spawned', pid: 456 });
    const next = await run();
    expect(spawnDaemon).toHaveBeenCalledWith(CLAW);
    expect(next[CLAW].status).toBe('retrying');
    expect(next[CLAW].awaitingStability).toBe(true);
  });

  it('alive claw → clear state + delete evidence', async () => {
    fs.mkdirSync(path.dirname(evidencePath(CLAW)), { recursive: true });
    fs.writeFileSync(evidencePath(CLAW), JSON.stringify({ schema_version: 1, executorId: CLAW, consecutiveAttempts: 3, openedAt: TIME_BASE - 1000 }));
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(aliveLiveness(123)) });
    const prior = { [CLAW]: { status: 'open', consecutiveAttempts: 3, openedAt: TIME_BASE - 1000 } };
    const next = await run(prior);
    expect(next[CLAW]).toBeUndefined();
    expect(readEvidence(CLAW)).toBeNull();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.WATCHDOG_CIRCUIT_REOPENED)).toBe(true);
  });

  it('clean-stop marker → no restart, state cleared', async () => {
    fs.writeFileSync(path.join(rootDir, '.chestnut', 'claws', CLAW, 'clean-stop'), '123');
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
    const prior = { [CLAW]: { status: 'retrying', consecutiveAttempts: 1, nextAttemptAt: TIME_BASE - 1 } };
    const next = await run(prior);
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(next[CLAW]).toBeUndefined();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_RECOVERY_SKIPPED)).toBe(true);
  });

  it('no active generation (never started) → no restart', async () => {
    // phase 1773 语义：absent（missing_active）不恢复（frozen 设计）。
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(absentLiveness('missing_active')) });
    const next = await run();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(next[CLAW]).toBeUndefined();
  });

  it('spawn conflict → reset to closed, no attempts', async () => {
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
    spawnDaemon.mockResolvedValue({ kind: 'spawn_conflict', reason: 'already_spawning' });
    const next = await run();
    expect(next[CLAW]).toBeUndefined();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED)).toBe(true);
  });

  it('spawn failure → retrying with attempts + defer', async () => {
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
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
    const sinkReport = vi.fn().mockResolvedValue({ kind: 'committed' });
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
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
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
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
    sinkReport.mockResolvedValue({ kind: 'committed' });
    next = await run(next);
    expect(sinkReport).toHaveBeenCalledTimes(2);
    expect(next[CLAW].sinkDelivered).toBe(true);
  });

  it('sink retryable outcome → evidence retained + delivery retried next tick（phase 1803）', async () => {
    const sinkReport = vi.fn().mockResolvedValueOnce({ kind: 'retryable', error: 'not closed: fs busy' });
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
    spawnDaemon.mockRejectedValue(new Error('fail'));

    let next: any = {};
    for (let i = 0; i < 4; i++) {
      now.mockReturnValue(TIME_BASE + i * 100_000);
      next = await run(next);
    }
    expect(sinkReport).toHaveBeenCalledTimes(1);
    expect(next[CLAW].sinkDelivered).toBeFalsy();
    expect(readEvidence(CLAW)).not.toBeNull();
    const failed = audit.entries.find(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_UNAVAILABLE_DELIVERY_FAILED);
    expect(failed).toBeDefined();
    expect(failed!.some(col => String(col).includes('not closed: fs busy'))).toBe(true);

    // 下一 tick 仍 circuit-open → 重试交付成功
    now.mockReturnValue(TIME_BASE + 500_000);
    sinkReport.mockResolvedValue({ kind: 'committed' });
    next = await run(next);
    expect(sinkReport).toHaveBeenCalledTimes(2);
    expect(next[CLAW].sinkDelivered).toBe(true);
  });

  it('sink rejected outcome → evidence retained + rejected audit，不标 delivered（phase 1803）', async () => {
    const sinkReport = vi.fn().mockResolvedValue({ kind: 'rejected', reason: 'executor mismatch' });
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
    spawnDaemon.mockRejectedValue(new Error('fail'));

    let next: any = {};
    for (let i = 0; i < 4; i++) {
      now.mockReturnValue(TIME_BASE + i * 100_000);
      next = await run(next);
    }
    expect(sinkReport).toHaveBeenCalledTimes(1);
    expect(next[CLAW].sinkDelivered).toBeFalsy();
    expect(readEvidence(CLAW)).not.toBeNull();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_UNAVAILABLE_DELIVERED)).toBe(false);
    const rejected = audit.entries.find(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_UNAVAILABLE_DELIVERY_REJECTED);
    expect(rejected).toBeDefined();
    expect(rejected!.some(col => String(col).includes('executor mismatch'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Phase 1878 Step B: alive-but-loop-stale 心跳监督
  // --------------------------------------------------------------------------

  it('alive + 心跳过期 → 走 restart machinery（审计含 stale 判定依据）', async () => {
    writeHeartbeat(CLAW, TIME_BASE - 180_001); // 超过 180s 阈值
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(aliveLiveness(123)) });
    spawnDaemon.mockResolvedValue({ kind: 'spawned', pid: 456 });
    const next = await run();
    expect(spawnDaemon).toHaveBeenCalledWith(CLAW);
    expect(next[CLAW].status).toBe('retrying');
    const stale = audit.entries.find(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_HEARTBEAT_STALE);
    expect(stale).toBeDefined();
    expect(stale!.some(col => String(col) === `heartbeat_ts=${TIME_BASE - 180_001}`)).toBe(true);
    expect(stale!.some(col => String(col) === 'stale_timeout_ms=180000')).toBe(true);
    expect(stale!.some(col => String(col) === 'pm=alive')).toBe(true);
  });

  it('alive + 心跳正常 → 零动作（不误杀、清理语义不变）', async () => {
    writeHeartbeat(CLAW, TIME_BASE - 60_000); // 阈值内
    fs.mkdirSync(path.dirname(evidencePath(CLAW)), { recursive: true });
    fs.writeFileSync(evidencePath(CLAW), JSON.stringify({ schema_version: 1, executorId: CLAW, consecutiveAttempts: 3, openedAt: TIME_BASE - 1000 }));
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(aliveLiveness(123)) });
    const prior = { [CLAW]: { status: 'open', consecutiveAttempts: 3, openedAt: TIME_BASE - 1000 } };
    const next = await run(prior);
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(next[CLAW]).toBeUndefined();
    expect(readEvidence(CLAW)).toBeNull();
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_HEARTBEAT_STALE)).toBe(false);
  });

  it('alive + 心跳缺失（升级窗口） → unknown：不重启 + audit，alive 清理语义不变', async () => {
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(aliveLiveness(123)) });
    const prior = { [CLAW]: { status: 'open', consecutiveAttempts: 3, openedAt: TIME_BASE - 1000 } };
    const next = await run(prior);
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(next[CLAW]).toBeUndefined();
    const unknown = audit.entries.find(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_HEARTBEAT_UNKNOWN);
    expect(unknown).toBeDefined();
    expect(unknown!.some(col => String(col) === 'reason=heartbeat_missing')).toBe(true);
  });

  it('alive + 心跳损坏 → unknown：不重启 + audit（不静默、不误判）', async () => {
    const p = path.join(rootDir, '.chestnut', 'claws', CLAW, 'daemon', 'heartbeat.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(aliveLiveness(123)) });
    const next = await run();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(next[CLAW]).toBeUndefined();
    const unknown = audit.entries.find(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_HEARTBEAT_UNKNOWN);
    expect(unknown).toBeDefined();
    expect(unknown!.some(col => String(col) === 'reason=heartbeat_corrupt')).toBe(true);
  });

  it('stale 重启与 dead 同 machinery：失败计入退避、触顶 circuit-open', async () => {
    writeHeartbeat(CLAW, TIME_BASE - 180_001);
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(aliveLiveness(123)) });
    spawnDaemon.mockRejectedValue(new Error('fail'));
    const next = await run();
    expect(next[CLAW].status).toBe('retrying');
    expect(next[CLAW].consecutiveAttempts).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Phase 1878 Step F: 损坏 evidence 显式隔离 + 审计（不静默折 null）
  // --------------------------------------------------------------------------

  it('损坏 evidence（JSON parse 失败）→ 隔离原文 + audit + delivered 证据显式重建', async () => {
    fs.mkdirSync(path.dirname(evidencePath(CLAW)), { recursive: true });
    fs.writeFileSync(evidencePath(CLAW), '{corrupt json');
    const sinkReport = vi.fn().mockResolvedValue({ kind: 'committed' });
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
    const prior = { [CLAW]: { status: 'open', consecutiveAttempts: 3, openedAt: TIME_BASE - 1000, sinkDelivered: false } };

    const next = await run(prior);

    expect(next[CLAW].sinkDelivered).toBe(true);
    // 原文隔离保留（DP 不丢：重命名不删除）
    const quarantined = fs.readdirSync(path.dirname(evidencePath(CLAW)))
      .filter(n => n.startsWith(`${CLAW}.json.corrupt-`));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(evidencePath(CLAW)), quarantined[0]), 'utf8'))
      .toBe('{corrupt json');
    // audit 含路径 / 隔离位置 / 原因
    const evt = audit.entries.find(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_RECOVERY_EVIDENCE_CORRUPT);
    expect(evt).toBeDefined();
    expect(evt!.some(col => String(col).startsWith('quarantine='))).toBe(true);
    expect(evt!.some(col => String(col) === 'quarantine_ok=true')).toBe(true);
    expect(evt!.some(col => String(col).startsWith('reason='))).toBe(true);
    // 交付决策可重建：delivered 终态证据自 openState 事实重建
    expect(readEvidence(CLAW)).toMatchObject({
      schema_version: 1,
      executorId: CLAW,
      consecutiveAttempts: 3,
      openedAt: TIME_BASE - 1000,
      sinkDelivered: true,
    });
  });

  it('损坏 evidence（schema 不符）→ 同 corrupt 处置（不静默覆盖重建）', async () => {
    fs.mkdirSync(path.dirname(evidencePath(CLAW)), { recursive: true });
    fs.writeFileSync(evidencePath(CLAW), JSON.stringify({ schema_version: 1, executorId: 123 }));
    const sinkReport = vi.fn().mockResolvedValue({ kind: 'committed' });
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
    const prior = { [CLAW]: { status: 'open', consecutiveAttempts: 2, openedAt: TIME_BASE - 500, sinkDelivered: false } };

    const next = await run(prior);

    expect(next[CLAW].sinkDelivered).toBe(true);
    const quarantined = fs.readdirSync(path.dirname(evidencePath(CLAW)))
      .filter(n => n.startsWith(`${CLAW}.json.corrupt-`));
    expect(quarantined).toHaveLength(1);
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_RECOVERY_EVIDENCE_CORRUPT)).toBe(true);
    expect(readEvidence(CLAW)).toMatchObject({ executorId: CLAW, sinkDelivered: true });
  });

  it('正常 evidence 路径零漂移：found 原位更新 delivered 标记、无隔离无 audit', async () => {
    fs.mkdirSync(path.dirname(evidencePath(CLAW)), { recursive: true });
    fs.writeFileSync(evidencePath(CLAW), JSON.stringify({
      schema_version: 1, executorId: CLAW, consecutiveAttempts: 3, openedAt: TIME_BASE - 1000,
    }));
    const sinkReport = vi.fn().mockResolvedValue({ kind: 'committed' });
    makeFailureSink.mockReturnValue({ report: sinkReport });
    pm = makeMockPm({ liveness: vi.fn().mockReturnValue(deadLiveness(123)) });
    const prior = { [CLAW]: { status: 'open', consecutiveAttempts: 3, openedAt: TIME_BASE - 1000, sinkDelivered: false } };

    const next = await run(prior);

    expect(next[CLAW].sinkDelivered).toBe(true);
    expect(readEvidence(CLAW)).toMatchObject({ executorId: CLAW, consecutiveAttempts: 3, sinkDelivered: true });
    expect(fs.readdirSync(path.dirname(evidencePath(CLAW))).filter(n => n.includes('corrupt'))).toHaveLength(0);
    expect(audit.entries.some(e => e[0] === WATCHDOG_AUDIT_EVENTS.EXECUTOR_RECOVERY_EVIDENCE_CORRUPT)).toBe(false);
  });
});
