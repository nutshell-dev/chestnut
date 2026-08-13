import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import {
  loadWatchdogState, saveWatchdogState,
} from '../../src/watchdog/watchdog-state.js';
import { clawRestartStateAPI, setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
import { maybeCronClawCrash } from '../../src/watchdog/watchdog-cron.js';
import { clawHasContract, gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

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
    clawHasContract: vi.fn(),
    clawHasActiveContract: vi.fn().mockReturnValue(true),
    gatherClawSnapshot: vi.fn(),
  };
});

describe('watchdog claw restart state persist (phase 1380)', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let clawsDir: string;
  let auditWriter: AuditWriter;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let mockPm: ProcessManager;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-restart-persist-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'motion', 'inbox', 'pending'), { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
    });
    vi.mocked(clawHasContract).mockReturnValue(true);
    vi.mocked(gatherClawSnapshot).mockReturnValue({
      contract: 'active:c1', outboxPending: 0, inboxPending: 0, status: 'stopped',
    } as any);

    auditWriter = new AuditWriter(
      new NodeFileSystem({ baseDir: chestnutDir }),
      'audit.tsv',
      null,
    );
    setAuditWriter(auditWriter);
    auditSpy = vi.spyOn(auditWriter, 'write');

    mockPm = {
      getAliveStatus: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue(4242),
    } as unknown as ProcessManager;

    clawRestartStateAPI.pruneStale(new Set());
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('crash attempt 推进 restart 状态并落盘；watchdog 重启 reload 后保留、defer 不重 spawn', async () => {
    const clawId = `claw-persist-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'test stopped' });

    // First crash → attempt → retrying 状态写入
    await maybeCronClawCrash(mockPm, auditWriter, fsFactory);
    expect(clawRestartStateAPI.get(clawId)).toBeDefined();
    expect((clawRestartStateAPI.get(clawId) as { status: string }).status).toBe('retrying');

    // Save state (simulate end-of-tick save)
    saveWatchdogState(fsFactory);

    // Reset in-memory state (simulate watchdog restart)
    _resetWatchdogContextForTest();
    clawRestartStateAPI.pruneStale(new Set());
    setAuditWriter(auditWriter);

    // Reload state → restart 状态恢复
    loadWatchdogState(fsFactory);
    const reloaded = clawRestartStateAPI.get(clawId);
    expect(reloaded).toBeDefined();
    expect((reloaded as { status: string }).status).toBe('retrying');
    expect((reloaded as { status: 'retrying'; consecutiveAttempts: number }).consecutiveAttempts).toBe(1);

    // 下 tick：nextAttemptAt 在未来 → defer、不重 spawn
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: false, reason: 'test stopped' });
    vi.mocked(mockPm.spawn).mockClear();
    await maybeCronClawCrash(mockPm, auditWriter, fsFactory);
    expect(mockPm.spawn).not.toHaveBeenCalled();
  });

  it('alive recovery 删除 restart 状态并落盘；reload 后不再有该 claw 状态', async () => {
    const clawId = `claw-recover-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(clawsDir, clawId), { recursive: true });

    // 先置 retrying 状态
    clawRestartStateAPI.set(clawId, {
      status: 'retrying',
      consecutiveAttempts: 2,
      nextAttemptAt: Date.now() + 100_000,
      awaitingStability: false,
    });

    // alive 恢复 → 状态删除
    vi.mocked(mockPm.getAliveStatus).mockReturnValue({ alive: true, reason: 'test alive' });
    await maybeCronClawCrash(mockPm, auditWriter, fsFactory);
    expect(clawRestartStateAPI.get(clawId)).toBeUndefined();
    expect(auditSpy).toHaveBeenCalledWith(
      'claw_restart_recovered',
      `claw=${clawId}`,
    );

    // Save → reload → 无状态
    saveWatchdogState(fsFactory);
    _resetWatchdogContextForTest();
    clawRestartStateAPI.pruneStale(new Set());
    setAuditWriter(auditWriter);
    loadWatchdogState(fsFactory);
    expect(clawRestartStateAPI.get(clawId)).toBeUndefined();
  });

  it('corrupt clawRestart 单条目 → drop + audit、不整体失败（其他条目保留）', async () => {
    const goodId = `claw-good-${randomUUID().slice(0, 8)}`;
    const badId = `claw-bad-${randomUUID().slice(0, 8)}`;

    saveWatchdogState(fsFactory);  // 先写正常 state.json 骨架
    const statePath = path.join(chestnutDir, 'watchdog-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.clawRestart = {
      [goodId]: { status: 'retrying', consecutiveAttempts: 1, nextAttemptAt: Date.now(), awaitingStability: true },
      [badId]: { status: 'bogus' },
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');

    _resetWatchdogContextForTest();
    clawRestartStateAPI.pruneStale(new Set());
    setAuditWriter(auditWriter);
    loadWatchdogState(fsFactory);

    expect(clawRestartStateAPI.get(goodId)).toBeDefined();
    expect(clawRestartStateAPI.get(badId)).toBeUndefined();
    expect(auditSpy).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
      'reason=claw_restart_entry_invalid',
      `claw=${badId}`,
      expect.any(String),
    );
  });
});
