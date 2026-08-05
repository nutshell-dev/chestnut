/**
 * phase 1258 Step A: claw_inactivity 两条触发路径共用同一 v1 wire 的 cron invariants.
 *
 * - maybeCronClawInactivity (普通 timeout) → 精确 v1 extraFields，无 source_path；
 * - maybeCronCheckSubscriptions (motion subscription) → 同一 v1 shape + typed
 *   source_path='subscription' + last_error（触发事实差异仅此两处 optional）；
 * - 两路径 extraFields 只经 owner codec 产出（writer 内不再有 Object.entries 提取）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { maybeCronClawInactivity, maybeCronCheckSubscriptions } from '../../src/watchdog/watchdog-cron.js';
import { clawStateAPI, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { clawHasActiveContract, gatherClawSnapshot, getClawActivityInfo } from '../../src/watchdog/watchdog-utils.js';
import { routeNotifyClaw } from '../../src/core/claw-topology/index.js';
import { listSubscriptions, consumeSubscription } from '../../src/watchdog/subscription-store.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
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
    clawHasContract: vi.fn(),
    clawHasActiveContract: vi.fn().mockReturnValue(true),
    gatherClawSnapshot: vi.fn(),
    getClawActivityInfo: vi.fn(),
  };
});

vi.mock('../../src/core/claw-topology/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/index.js')>();
  return {
    ...actual,
    routeNotifyClaw: vi.fn(),
  };
});

vi.mock('../../src/watchdog/subscription-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/subscription-store.js')>();
  return {
    ...actual,
    listSubscriptions: vi.fn(),
    consumeSubscription: vi.fn(),
  };
});

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('phase 1258 Step A: claw_inactivity v1 wire — two trigger paths, one schema', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;
  let mockAudit: { write: ReturnType<typeof vi.fn> };
  let inboxWriteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(tmpdir(), `wd-inactivity-${randomUUID()}`);
    const chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'motion', 'inbox', 'pending'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 5_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });
    vi.mocked(clawHasActiveContract).mockReturnValue(true);
    vi.mocked(gatherClawSnapshot).mockReturnValue({
      contract: 'active:c1', outboxPending: 0, inboxPending: 0, status: 'running',
    } as any);

    mockPm = { isAlive: vi.fn().mockReturnValue(true) } as unknown as ProcessManager;
    mockAudit = {
      write: vi.fn(),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    };
    inboxWriteMock = vi.fn();
    vi.mocked(routeNotifyClaw).mockImplementation(inboxWriteMock);

    clawStateAPI.lastInactivityNotified.clear();
    clawStateAPI.inactivityNotifyCount.clear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('timeout path: maybeCronClawInactivity fires exact v1 shape (no source_path / no last_error)', async () => {
    const clawId = `claw-timeout-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // 超时 400s > 300s threshold、无 last error → daemon_silent
    vi.mocked(getClawActivityInfo).mockResolvedValue({
      lastEventMs: Date.now() - 400_000,
      lastError: null,
    } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await maybeCronClawInactivity(mockPm, mockAudit as any, fsFactory);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    // 精确 v1 shape（多/少一个 key 即失败）：version + 6 owned required fields、
    // 无 source_path（普通 timeout）、无 last_error（无错误）
    expect(inboxWriteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'motion',
      'motion',
      {
        type: 'claw_inactivity',
        source: 'watchdog',
        priority: 'normal',
        body: expect.any(String),
        idPrefix: expect.stringMatching(/_claw_inactivity$/),
        extraFields: {
          guidance_schema_version: '1',
          claw_id: clawId,
          failure_class: 'daemon_silent',
          inactive_ms: expect.any(String),
          contract: 'active:c1',
          as_of: expect.any(String),
        },
      },
      expect.anything(),
    );
    logSpy.mockRestore();
  });

  it('subscription path: maybeCronCheckSubscriptions fires same v1 shape + typed source_path + last_error', async () => {
    const clawId = `claw-sub-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    vi.mocked(listSubscriptions).mockReturnValue([
      { clawId, subscribed_at: Date.now() - 600_000, threshold_ms: 300_000 },
    ] as any);
    // stuck + 有 last error → daemon_errored
    vi.mocked(getClawActivityInfo).mockResolvedValue({
      lastEventMs: null,
      lastError: 'LLM timeout',
    } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await maybeCronCheckSubscriptions(mockPm, mockAudit as any, fsFactory);

    expect(inboxWriteMock).toHaveBeenCalledTimes(1);
    // 与 timeout 同 v1 schema，差异仅 subscription 触发事实（source_path + last_error）
    expect(inboxWriteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'motion',
      'motion',
      {
        type: 'claw_inactivity',
        source: 'watchdog',
        priority: 'normal',
        body: expect.any(String),
        idPrefix: expect.stringMatching(/_claw_inactivity$/),
        extraFields: {
          guidance_schema_version: '1',
          claw_id: clawId,
          failure_class: 'daemon_errored',
          inactive_ms: expect.any(String),
          contract: 'active:c1',
          as_of: expect.any(String),
          source_path: 'subscription',
          last_error: 'LLM timeout',
        },
      },
      expect.anything(),
    );
    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_FIRED,
      `claw=${clawId}`,
      'threshold_ms=300000',
      'failure_class=daemon_errored',
    );
    expect(consumeSubscription).toHaveBeenCalledWith(expect.anything(), clawId);
    logSpy.mockRestore();
  });

  it('timeout path 与 subscription path 的 required wire keys 完全一致（同一 schema）', async () => {
    const timeoutClaw = `claw-t-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, timeoutClaw), { recursive: true });
    vi.mocked(getClawActivityInfo).mockResolvedValue({
      lastEventMs: Date.now() - 400_000,
      lastError: null,
    } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await maybeCronClawInactivity(mockPm, mockAudit as any, fsFactory);

    const subClaw = `claw-s-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, subClaw), { recursive: true });
    vi.mocked(listSubscriptions).mockReturnValue([
      { clawId: subClaw, subscribed_at: Date.now() - 600_000, threshold_ms: 300_000 },
    ] as any);
    // 仍 stuck（无新 stream event）→ 走 (d) fire 分支而非 (b) recovered-consume
    vi.mocked(getClawActivityInfo).mockResolvedValue({
      lastEventMs: null,
      lastError: null,
    } as any);
    await maybeCronCheckSubscriptions(mockPm, mockAudit as any, fsFactory);

    expect(inboxWriteMock).toHaveBeenCalledTimes(2);
    const timeoutKeys = Object.keys((inboxWriteMock.mock.calls[0][4] as any).extraFields).sort();
    const subKeys = Object.keys((inboxWriteMock.mock.calls[1][4] as any).extraFields).sort();
    // 两 dialect 共有 required key 集合，subscription 只多 source_path
    expect(timeoutKeys).toEqual([
      'as_of', 'claw_id', 'contract', 'failure_class', 'guidance_schema_version', 'inactive_ms',
    ]);
    expect(subKeys).toEqual([...timeoutKeys, 'source_path']);
    logSpy.mockRestore();
  });
});
