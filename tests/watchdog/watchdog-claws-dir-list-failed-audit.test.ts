/**
 * Phase 149: watchdog 3 处 no-catch listSync audit + recovery
 *
 * 反向测试：
 * 1. watchdog tick listSync EACCES → emit CLAWS_DIR_LIST_FAILED + daemon 不死
 * 2. ENOENT after existsSync (race) → 0 audit + treat empty
 * 3. listSync 正常 → 既有行为 0 改
 * 4. cron fn listSync EACCES → audit + early return
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { runWatchdogLoop, _resetShutdownGuard } from '../../src/watchdog/watchdog.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';
import { getNamedSubrootDir } from '../../src/foundation/claw-identity/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { makeMockAudit } from '../helpers/audit.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { setTimeout as setTimeoutP } from 'timers/promises';
import {
  getChestnutFs,
  _resetWatchdogContextForTest,
  clawsSupervisionStateAPI,
} from '../../src/watchdog/watchdog-context.js';
import { aliveLiveness } from '../helpers/liveness-fixtures.js';
import { saveWatchdogState } from '../../src/watchdog/watchdog-state.js';
import { WATCHDOG_PATHS } from '../../src/watchdog/layout.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/foundation/claw-identity/instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
  };
});
vi.mock('../../src/foundation/config-store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config-store/index.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
}));

vi.mock('../../src/foundation/process-manager/factories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/factories.js')>();
  return {
    ...actual,
    createProcessManagerForCLI: vi.fn(),
  };
});

vi.mock('timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/watchdog/watchdog-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-context.js')>();
  return {
    ...actual,
    getChestnutFs: vi.fn(),
    getWatchdogConfig: vi.fn(),
  };
});

import { createProcessManagerForCLI } from '../../src/foundation/process-manager/factories.js';
import { getNamedSubrootDir } from '../../src/foundation/claw-identity/index.js';
import { getChestnutFs, getWatchdogConfig } from '../../src/watchdog/watchdog-context.js';

describe('watchdog claws dir listSync audit + recovery (phase 149)', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let clawsDir: string;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(tmpdir(), `wd149-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    fs.mkdirSync(path.join(chestnutDir, 'motion', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'logs'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    // Phase 1289 Step C: watchdog runtime 消费自家 workspace config store（此处经 context mock）
    vi.mocked(getWatchdogConfig).mockReturnValue({
      interval_ms: 5_000,
    });
    vi.mocked(getChestnutFs).mockImplementation((factory: (baseDir: string) => FileSystem) => factory(chestnutDir));

    _resetShutdownGuard();
  });

  afterEach(() => {
    _resetShutdownGuard();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── runWatchdogLoop tick helpers ───────────────────────────────────────────

  let auditWriteSpy: ReturnType<typeof vi.spyOn>;

  let timerDelays: number[] = [];

  async function runLoopForTicks(
    tickCount: number,
    onAuditWrite?: (call: [string, ...(string | number)[]]) => void,
  ): Promise<void> {
    const mockPm = {
      liveness: vi.fn().mockReturnValue(aliveLiveness()),
      isAlive: vi.fn().mockReturnValue(true),
      spawn: vi.fn().mockResolvedValue(9999),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../../src/foundation/process-manager/index.js').ProcessManager;
    vi.mocked(createProcessManagerForCLI).mockReturnValue(mockPm);

    auditWriteSpy = vi.spyOn(AuditWriter.prototype, 'write').mockImplementation(function(this: AuditWriter, type: string, ...cols: (string | number)[]) {
      onAuditWrite?.([type, ...cols]);
      // No-op: we inspect calls via spy, no real file I/O
    });

    let simulatedNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => simulatedNow);
    timerDelays = [];
    let sleeps = 0;
    const originalSetTimeout = vi.mocked(setTimeoutP);
    originalSetTimeout.mockImplementation(async (delay?: number) => {
      timerDelays.push(Number(delay ?? 0));
      simulatedNow += Number(delay ?? 0);
      sleeps += 1;
      if (sleeps === tickCount) {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
        process.emit('SIGTERM');
        exitSpy.mockRestore();
      }
    });
    try {
      await runWatchdogLoop(fsFactory);
    } catch {
      // process.exit mock may throw — expected only after the final timer fired.
    }
    expect(sleeps).toBe(tickCount);
  }

  async function runLoopForOneTick(): Promise<void> {
    return runLoopForTicks(1);
  }

  function getAuditCalls(): Array<[string, ...(string | number)[]]> {
    return auditWriteSpy?.mock.calls as Array<[string, ...(string | number)[]]> ?? [];
  }

  // ── Reverse 1: watchdog tick directory failure → unknown coverage ─────────

  it.each([
    ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'],
    ['ENOSYS', 'missing_capability'],
    ['EIO', 'io_failed'],
  ] as const)('reverse 1: listSync %s → degraded unknown coverage + daemon 不死', async (code, reason) => {
    fs.mkdirSync(clawsDir, { recursive: true });

    const listError = Object.assign(new Error(`list failed ${code}`), { code });
    vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation((p: string, _opts?: unknown) => {
      if (p === 'claws') throw listError;
      const realFs = new NodeFileSystem({ baseDir: chestnutDir });
      return realFs.listSync(p, _opts as any);
    });

    await runLoopForOneTick();

    const calls = getAuditCalls();
    const failed = calls.find(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED);
    const degraded = calls.find(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_DEGRADED);
    const check = calls.find(([type]) => type === WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK);
    expect(failed).toBeDefined();
    expect(failed).toEqual(expect.arrayContaining([
      WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
      'ctx=watchdog_tick',
      `reason=${reason}`,
      `code=${code}`,
    ]));
    expect(degraded).toEqual(expect.arrayContaining([
      WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_DEGRADED,
      `code=${code}`,
      'consecutive_failures=1',
      expect.stringMatching(/^next_retry_at=\d+$/),
      expect.stringContaining(`list failed ${code}`),
    ]));
    expect(check).toEqual(expect.arrayContaining([
      WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK,
      'coverage=unknown',
      'reason=directory_unavailable',
    ]));
    expect(check?.some(col => String(col).startsWith('present='))).toBe(false);
    expect(clawsSupervisionStateAPI.snapshot()).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 1,
      lastFailure: { code, reason, error: expect.stringContaining(`list failed ${code}`) },
    });
  });

  // ── Reverse 2: ENOENT after existsSync (race) ──────────────────────────────

  it('reverse 2: ENOENT after existsSync (race) → 0 audit + treat empty', async () => {
    fs.mkdirSync(clawsDir, { recursive: true });

    const enoentErr = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const listSyncSpy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation((p: string, _opts?: unknown) => {
      if (p === 'claws') throw enoentErr;
      const realFs = new NodeFileSystem({ baseDir: chestnutDir });
      return realFs.listSync(p, _opts as any);
    });

    await runLoopForOneTick();

    const calls = getAuditCalls();
    expect(calls.some(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED)).toBe(false);
    expect(calls.some(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_DEGRADED)).toBe(false);
    const check = calls.find(([type]) => type === WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK);
    expect(check).toEqual(expect.arrayContaining([
      WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK,
      'present=',
      'coverage=known',
    ]));
    expect(clawsSupervisionStateAPI.snapshot().status).toBe('covered');

    listSyncSpy.mockRestore();
  });

  // ── Reverse 3: listSync 正常 ───────────────────────────────────────────────

  it('reverse 3: listSync 正常 → 既有行为 0 改', async () => {
    fs.mkdirSync(path.join(clawsDir, 'claw-A'), { recursive: true });
    fs.mkdirSync(path.join(clawsDir, 'claw-B'), { recursive: true });

    await runLoopForOneTick();

    const calls = getAuditCalls();
    expect(calls.some(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED)).toBe(false);
    expect(calls.some(([type]) => type === 'watchdog_check')).toBe(true);
    expect(calls.some(([type, ...cols]) => type === 'watchdog_check' && cols.some(c => String(c).includes('claw-A')))).toBe(true);
    expect(calls.some(([type, ...cols]) => type === 'watchdog_check' && cols.some(c => String(c).includes('claw-B')))).toBe(true);
    expect(calls.some(([type, ...cols]) => type === 'watchdog_check' && cols.includes('coverage=known'))).toBe(true);
  });

  it('连续失败按退避重试，恢复事件先于真实 present 集合恢复', async () => {
    vi.mocked(getWatchdogConfig).mockReturnValue({ interval_ms: 30_000 });
    fs.mkdirSync(path.join(clawsDir, 'claw-A'), { recursive: true });
    const originalListSync = NodeFileSystem.prototype.listSync;
    let clawsReads = 0;
    vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(function (
      this: NodeFileSystem,
      p: string,
      opts?: unknown,
    ) {
      if (p === 'claws') {
        clawsReads += 1;
        if (clawsReads <= 2) {
          throw Object.assign(new Error(`denied ${clawsReads}`), { code: 'EACCES' });
        }
      }
      return originalListSync.call(this, p, opts as any);
    });

    const persistedFailuresAtEvent: number[] = [];
    let persistedStatusAtRecovery: string | undefined;
    await runLoopForTicks(4, ([type]) => {
      if (
        type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_DEGRADED
        || type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_RECOVERED
      ) {
        const state = JSON.parse(fs.readFileSync(path.join(chestnutDir, WATCHDOG_PATHS.state), 'utf8'));
        if (type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_DEGRADED) {
          persistedFailuresAtEvent.push(state.clawsSupervision.consecutiveFailures);
        } else {
          persistedStatusAtRecovery = state.clawsSupervision.status;
        }
      }
    });

    expect(persistedFailuresAtEvent).toEqual([1, 2]);
    expect(persistedStatusAtRecovery).toBe('covered');
    expect(clawsReads).toBe(3);
    expect(timerDelays).toEqual([30_000, 30_000, 30_000, 30_000]);
    const calls = getAuditCalls();
    const degraded = calls.filter(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_DEGRADED);
    expect(degraded).toHaveLength(2);
    expect(degraded[0]).toContain('consecutive_failures=1');
    expect(degraded[1]).toContain('consecutive_failures=2');
    const firstObservedAt = Number(degraded[0].find(col => String(col).startsWith('observed_at='))?.toString().split('=')[1]);
    const secondObservedAt = Number(degraded[1].find(col => String(col).startsWith('observed_at='))?.toString().split('=')[1]);
    const secondRetryAt = Number(degraded[1].find(col => String(col).startsWith('next_retry_at='))?.toString().split('=')[1]);
    expect(secondObservedAt - firstObservedAt).toBe(30_000);
    expect(secondRetryAt - secondObservedAt).toBe(60_000);

    const checks = calls.filter(([type]) => type === WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK);
    expect(checks).toHaveLength(4);
    for (const check of checks.slice(0, 3)) {
      expect(check).toContain('coverage=unknown');
      expect(check.some(col => String(col).startsWith('present='))).toBe(false);
    }
    expect(checks[3]).toEqual(expect.arrayContaining(['coverage=known', 'present=claw-A']));
    const recoveredIndex = calls.findIndex(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_RECOVERED);
    expect(recoveredIndex).toBeGreaterThanOrEqual(0);
    expect(calls[recoveredIndex]).toContain('previous_failures=2');
    expect(recoveredIndex).toBeLessThan(calls.lastIndexOf(checks[3]));
    expect(clawsSupervisionStateAPI.snapshot()).toMatchObject({
      status: 'covered',
      consecutiveFailures: 0,
      nextRetryAtMs: 0,
      lastRecoveredAtMs: expect.any(Number),
    });
  });

  it('fresh loop 遵守已持久化 retry deadline，成功恢复只写一次 recovered', async () => {
    vi.mocked(getWatchdogConfig).mockReturnValue({ interval_ms: 30_000 });
    fs.mkdirSync(path.join(clawsDir, 'claw-A'), { recursive: true });
    const failedAt = Date.now();
    clawsSupervisionStateAPI.replace({
      status: 'degraded',
      consecutiveFailures: 2,
      lastFailure: {
        directory: 'claws',
        observedAtMs: failedAt,
        outcome: 'unavailable',
        reason: 'permission_denied',
        code: 'EACCES',
        error: 'permission denied',
      },
      nextRetryAtMs: failedAt + 60_000,
    });
    saveWatchdogState(fsFactory);
    _resetWatchdogContextForTest();
    expect(clawsSupervisionStateAPI.snapshot().status).toBe('covered');

    const originalListSync = NodeFileSystem.prototype.listSync;
    let clawsReads = 0;
    vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation(function (
      this: NodeFileSystem,
      p: string,
      opts?: unknown,
    ) {
      if (p === 'claws') clawsReads += 1;
      return originalListSync.call(this, p, opts as any);
    });

    await runLoopForTicks(3);

    expect(clawsReads).toBe(1);
    const calls = getAuditCalls();
    const checks = calls.filter(([type]) => type === WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK);
    expect(checks).toHaveLength(3);
    expect(checks[0]).toContain('coverage=unknown');
    expect(checks[1]).toContain('coverage=unknown');
    expect(checks[2]).toEqual(expect.arrayContaining(['coverage=known', 'present=claw-A']));
    expect(calls.filter(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_DEGRADED)).toHaveLength(0);
    expect(calls.filter(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_SUPERVISION_RECOVERED)).toHaveLength(1);
  });

});
