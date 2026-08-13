/**
 * cron heartbeat invariants — phase 1383 Step D (U4).
 *
 * maybeCronClawHeartbeat: 进程 alive 但心跳文件过期（事件循环全阻塞兜底）→
 * 复用 crash 重启状态机（clawRestartStateAPI + attemptClawRestart）重启。
 *
 * 覆盖：
 *  - alive + 新鲜心跳 → no-op（不重启、不 audit）
 *  - alive + 过期心跳 + active contract → CLAW_HEARTBEAT_STALE + spawn + 状态机推进
 *  - alive + 无心跳文件（存量旧 daemon / 刚启动）→ HEARTBEAT_CHECK_FAILED + skip（不误重启）
 *  - alive + 非法心跳内容 → HEARTBEAT_CHECK_FAILED + skip
 *  - dead 进程 → skip（crash 路径负责）
 *  - alive + 无 active contract → skip
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawHeartbeat } from '../../src/watchdog/watchdog-cron.js';
import { clawRestartStateAPI, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { HEARTBEAT_STALE_TIMEOUT_MS } from '../../src/watchdog/constants.js';
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
  return { ...actual };
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

vi.mock('../../src/watchdog/workspace-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/workspace-config.js')>();
  return { ...actual, readWorkspaceWatchdogConfig: vi.fn() };
});

vi.mock('../../src/watchdog/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-utils.js')>();
  return { ...actual, clawHasActiveContract: vi.fn().mockReturnValue(true) };
});

describe('watchdog-cron-heartbeat (phase 1383 Step D / U4)', () => {
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  let tmpDir: string;
  let chestnutDir: string;
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
    tmpDir = path.join(tmpdir(), `wd-hb-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'motion', 'inbox', 'pending'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({ interval_ms: 30_000, disk_warning_mb: 500 });
    vi.mocked(clawHasActiveContract as any).mockReturnValue(true);

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

  function writeHeartbeat(clawId: string, date: Date): void {
    const clawDir = path.join(clawsDir, clawId);
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'heartbeat'), date.toISOString());
  }

  it('alive + 新鲜心跳 → no-op（不重启、无 stale/失败 audit）', async () => {
    const clawId = `claw-fresh-${randomUUID().slice(0, 8)}`;
    writeHeartbeat(clawId, new Date());
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: '' });

    await maybeCronClawHeartbeat(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockPm.spawn).not.toHaveBeenCalled();
    expect(mockPm.stop).not.toHaveBeenCalled();
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_HEARTBEAT_STALE,
      expect.anything(),
      expect.anything(),
    );
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.HEARTBEAT_CHECK_FAILED,
      expect.anything(),
      expect.anything(),
    );
  });

  it('alive + 过期心跳 + active contract → CLAW_HEARTBEAT_STALE + spawn 重启 + 状态机推进', async () => {
    const clawId = `claw-stale-${randomUUID().slice(0, 8)}`;
    writeHeartbeat(clawId, new Date(Date.now() - HEARTBEAT_STALE_TIMEOUT_MS - 60_000));
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: '' });

    await maybeCronClawHeartbeat(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_HEARTBEAT_STALE,
      `claw=${clawId}`,
      `process_alive=true`,
      expect.stringContaining('stale_ms='),
    );
    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED,
      `claw=${clawId}`,
      `reason=heartbeat_stale`,
    );
    expect(mockPm.stop).toHaveBeenCalledOnce();
    expect(mockPm.spawn).toHaveBeenCalledOnce();
    expect(mockAudit.write).toHaveBeenCalledWith(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED,
      `claw=${clawId}`,
      expect.stringContaining('pid='),
    );
    // 状态机推进到 retrying
    const state = clawRestartStateAPI.get(clawId);
    expect(state).toBeDefined();
    expect(state?.status).toBe('retrying');
    expect(state?.consecutiveAttempts).toBe(1);
  });

  it('alive + 无心跳文件（存量旧 daemon/刚启动）→ HEARTBEAT_CHECK_FAILED + skip（不重启）', async () => {
    const clawId = `claw-nohb-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: '' });

    await maybeCronClawHeartbeat(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.HEARTBEAT_CHECK_FAILED,
      `claw=${clawId}`,
      `reason=missing_or_invalid`,
    );
    expect(mockPm.spawn).not.toHaveBeenCalled();
    expect(clawRestartStateAPI.get(clawId)).toBeUndefined();
  });

  it('alive + 非法心跳内容 → HEARTBEAT_CHECK_FAILED + skip（不重启）', async () => {
    const clawId = `claw-badhb-${randomUUID().slice(0, 8)}`;
    const clawDir = path.join(clawsDir, clawId);
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'heartbeat'), 'not-a-timestamp');
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: '' });

    await maybeCronClawHeartbeat(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.HEARTBEAT_CHECK_FAILED,
      `claw=${clawId}`,
      `reason=missing_or_invalid`,
    );
    expect(mockPm.spawn).not.toHaveBeenCalled();
  });

  it('dead 进程 → skip（不查心跳、不重启；crash 路径负责）', async () => {
    const clawId = `claw-dead-${randomUUID().slice(0, 8)}`;
    // 即使心跳过期，进程死也不该由 heartbeat 路径处理
    writeHeartbeat(clawId, new Date(Date.now() - HEARTBEAT_STALE_TIMEOUT_MS - 60_000));
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'test stopped' });

    await maybeCronClawHeartbeat(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockPm.spawn).not.toHaveBeenCalled();
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_HEARTBEAT_STALE,
      expect.anything(),
      expect.anything(),
    );
  });

  it('alive + 过期心跳 + 无 active contract → skip（不重启）', async () => {
    const clawId = `claw-nocontract-${randomUUID().slice(0, 8)}`;
    writeHeartbeat(clawId, new Date(Date.now() - HEARTBEAT_STALE_TIMEOUT_MS - 60_000));
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: '' });
    vi.mocked(clawHasActiveContract as any).mockReturnValue(false);

    await maybeCronClawHeartbeat(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);

    expect(mockPm.spawn).not.toHaveBeenCalled();
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_HEARTBEAT_STALE,
      expect.anything(),
      expect.anything(),
    );
  });

  it('连续过期 tick 受 backoff/circuit 状态机约束（第二 tick defer、不重复 spawn）', async () => {
    const clawId = `claw-defer-${randomUUID().slice(0, 8)}`;
    writeHeartbeat(clawId, new Date(Date.now() - HEARTBEAT_STALE_TIMEOUT_MS - 60_000));
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: '' });
    vi.mocked(clawHasActiveContract as any).mockReturnValue(true);

    await maybeCronClawHeartbeat(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);
    expect(mockPm.spawn).toHaveBeenCalledTimes(1);

    // 第二 tick：仍过期，但状态机在退避窗口内 → defer、不再 spawn
    vi.clearAllMocks();
    await maybeCronClawHeartbeat(mockPm as unknown as ProcessManager, mockAudit as any, fsFactory);
    expect(mockPm.spawn).not.toHaveBeenCalled();
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_HEARTBEAT_STALE,
      expect.anything(),
      expect.anything(),
    );
  });
});
