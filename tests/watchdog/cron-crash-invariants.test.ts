/**
 * cron crash invariants — phase 1380 rewrite.
 *
 * phase 1380: maybeCronClawCrash 从「检测 + 通知 motion + dedup」改为
 * 「检测 → decideDaemonRestart 状态机 → attemptClawRestart（backoff + 熔断）」。
 * 四路判定全覆盖：
 *  - skip-no-contract（audit）
 *  - restart attempt（spawn 调用 + 状态推进）
 *  - defer（退避窗口内）
 *  - circuit-open（熔断 audit、justOpened 只发一次）
 *  + alive 恢复清状态（CLAW_RESTART_RECOVERED）+ claw 消失 prune
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawStateAPI, clawRestartStateAPI, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { clawHasActiveContract } from '../../src/watchdog/watchdog-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../src/foundation/process-manager/index.js';

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
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
  buildLLMConfig: vi.fn(),
}));

// Phase 1289 Step C: watchdog runtime 消费自家 workspace config store
vi.mock('../../src/watchdog/workspace-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/workspace-config.js')>();
  return {
    ...actual,
    readWorkspaceWatchdogConfig: vi.fn(),
  };
});

vi.mock('../../src/watchdog/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-utils.js')>();
  return {
    ...actual,
    clawHasActiveContract: vi.fn().mockReturnValue(true),
  };
});

describe('watchdog-cron-crash (phase 1380 自动重启状态机)', () => {
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  let tmpDir: string;
  let clawsDir: string;
  let mockPm: {
    getAliveStatus: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    spawn: ReturnType<typeof vi.fn>;
  };
  let mockAudit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(tmpdir(), `wd-crash-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'motion', 'inbox', 'pending'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500,
    });

    mockPm = {
      getAliveStatus: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue(4242),
    };
    mockAudit = {
      write: vi.fn(),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('skip-no-contract: dead claw + no active contract → CLAW_CRASH_SKIPPED_NO_CONTRACT、无 spawn', async () => {
    const clawId = `claw-skip-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'test stopped' });
    vi.mocked(clawHasActiveContract as any).mockReturnValue(false);

    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_SKIPPED_NO_CONTRACT,
      `claw=${clawId}`,
      `reason=no_active_contract`,
    );
    expect(mockPm.spawn).not.toHaveBeenCalled();
  });

  it('restart attempt: dead + active contract + closed → CLAW_CRASH_DETECTED + spawn + 状态推进 retrying', async () => {
    const clawId = `claw-attempt-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'test stopped' });
    vi.mocked(clawHasActiveContract as any).mockReturnValue(true);

    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
      expect.stringContaining(clawId),
      'has_contract=true',
      expect.stringContaining('crash_class='),
    );
    expect(mockPm.stop).toHaveBeenCalledTimes(1);
    expect(mockPm.spawn).toHaveBeenCalledTimes(1);
    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED,
      `claw=${clawId}`,
      `reason=crash_detected`,
    );
    expect(mockAudit.write).toHaveBeenCalledWith(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED,
      `claw=${clawId}`,
      `pid=4242`,
    );
    // 状态推进：spawned → retrying（attempts=1、nextAttemptAt=now+intervalMs）
    const state = clawRestartStateAPI.get(clawId);
    expect(state).toBeDefined();
    expect(state!.status).toBe('retrying');
    expect((state as { status: 'retrying'; consecutiveAttempts: number }).consecutiveAttempts).toBe(1);
    expect((state as { status: 'retrying'; nextAttemptAt: number }).nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it('spawn 失败 → failed 分支推进 attempts、不计 spawn_conflict 为失败', async () => {
    const clawId = `claw-fail-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'test stopped' });
    vi.mocked(clawHasActiveContract as any).mockReturnValue(true);
    vi.mocked(mockPm.spawn).mockRejectedValue(new Error('spawn boom'));

    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockAudit.write).toHaveBeenCalledWith(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
      `claw=${clawId}`,
      expect.stringContaining('error='),
    );
    const state = clawRestartStateAPI.get(clawId);
    expect(state!.status).toBe('retrying');
    expect((state as { status: 'retrying'; consecutiveAttempts: number }).consecutiveAttempts).toBe(1);
  });

  it('defer: retrying 且 nextAttemptAt 在未来 → 无 spawn、无 CLAW_CRASH_DETECTED', async () => {
    const clawId = `claw-defer-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    clawRestartStateAPI.set(clawId, {
      status: 'retrying',
      consecutiveAttempts: 1,
      nextAttemptAt: Date.now() + 100_000,
      awaitingStability: false,
    });
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'test stopped' });
    vi.mocked(clawHasActiveContract as any).mockReturnValue(true);

    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockPm.spawn).not.toHaveBeenCalled();
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('circuit-open: attempts >= max → CLAW_RESTART_CIRCUIT_OPENED（justOpened 只发一次）、无 spawn', async () => {
    const clawId = `claw-circuit-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    clawRestartStateAPI.set(clawId, {
      status: 'retrying',
      consecutiveAttempts: 10,
      nextAttemptAt: Date.now() - 1_000,
      awaitingStability: false,
    });
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'test stopped' });
    vi.mocked(clawHasActiveContract as any).mockReturnValue(true);

    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);
    expect(mockPm.spawn).not.toHaveBeenCalled();
    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_RESTART_CIRCUIT_OPENED,
      `claw=${clawId}`,
      `attempts=10`,
      `cap=10`,
    );
    const state = clawRestartStateAPI.get(clawId);
    expect(state!.status).toBe('open');

    // 第二 tick：已 open → 不再 emit justOpened
    vi.mocked(mockAudit.write).mockClear();
    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_RESTART_CIRCUIT_OPENED,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('alive 恢复 → 清 restart 状态 + CLAW_RESTART_RECOVERED audit', async () => {
    const clawId = `claw-recover-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    clawRestartStateAPI.set(clawId, {
      status: 'retrying',
      consecutiveAttempts: 3,
      nextAttemptAt: Date.now() + 100_000,
      awaitingStability: false,
    });
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: 'test alive' });

    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(clawRestartStateAPI.get(clawId)).toBeUndefined();
    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_RESTART_RECOVERED,
      `claw=${clawId}`,
    );
    expect(mockPm.spawn).not.toHaveBeenCalled();
  });

  it('alive claw 无 restart 状态 → 0 dead sub-branch audit', async () => {
    const clawId = `claw-alive-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: 'test alive' });

    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    const deadEvents = [
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_SKIPPED_NO_CONTRACT,
      WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
      WATCHDOG_AUDIT_EVENTS.CLAW_RESTART_CIRCUIT_OPENED,
    ];
    for (const eventType of deadEvents) {
      const callsForEvent = vi.mocked(mockAudit.write).mock.calls.filter(
        (call) => call[0] === eventType,
      );
      expect(callsForEvent).toHaveLength(0);
    }
  });

  it('claw dir 消失 → clawRestartState prune', async () => {
    const clawId = `claw-gone-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    clawRestartStateAPI.set(clawId, {
      status: 'retrying',
      consecutiveAttempts: 1,
      nextAttemptAt: Date.now() + 100_000,
      awaitingStability: false,
    });
    clawStateAPI.everSpawned.add(clawId);

    fs.rmSync(path.join(clawsDir, clawId), { recursive: true, force: true });

    await maybeCronClawCrash(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(clawRestartStateAPI.get(clawId)).toBeUndefined();
    expect(clawStateAPI.everSpawned.has(clawId)).toBe(false);
    expect(clawStateAPI.clawPreviouslyAlive.has(clawId)).toBe(false);
  });
});
