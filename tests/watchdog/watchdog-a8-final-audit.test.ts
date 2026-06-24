/**
 * Phase 155: watchdog A.8 收官 3 处 silent/text-log-only audit 补齐。
 *
 * 反向测试：
 * 1. subscription-store outer listSync EACCES → emit SUBSCRIPTION_DIR_LIST_FAILED + return []
 * 2. subscription-store outer listSync ENOENT → 0 audit + return []
 * 3. claw inactivity check throw → emit CLAW_INACTIVITY_CHECK_FAILED（不影响其他 claw）
 * 4. subscription process throw → emit SUBSCRIPTION_PROCESS_FAILED + 不 consume
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNode from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { listSubscriptions } from '../../src/watchdog/subscription-store.js';
import { maybeCronClawInactivity, maybeCronCheckSubscriptions } from '../../src/watchdog/watchdog-cron.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { makeMockAudit } from '../helpers/audit.js';

declare global {
  // eslint-disable-next-line no-var
  var FileSystem: unknown;
}

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(),
  };
});
vi.mock('../../src/assembly/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config-loader.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

vi.mock('../../src/watchdog/watchdog-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-context.js')>();
  return {
    ...actual,
    getChestnutFs: vi.fn(),
    getGlobalConfig: vi.fn(),
  };
});

vi.mock('../../src/watchdog/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-utils.js')>();
  return {
    ...actual,
    getClawActivityInfo: vi.fn().mockRejectedValue(
      Object.assign(new Error('EIO failure'), { code: 'EIO' }),
    ),
  };
});

import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../../src/assembly/config-load.js';
import { getChestnutFs, getGlobalConfig, clawStateAPI, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('watchdog A.8 final audit emit (phase 155)', () => {
  let tmpDir: string;
  let chestnutDir: string;
  let clawsDir: string;
  let subscriptionsDir: string;

  beforeEach(() => {
    _resetWatchdogContextForTest();
    tmpDir = path.join(tmpdir(), `wd155-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    clawsDir = path.join(chestnutDir, 'claws');
    subscriptionsDir = path.join(chestnutDir, 'watchdog-subscriptions');

    fsNode.mkdirSync(path.join(chestnutDir, 'motion', 'logs'), { recursive: true });
    fsNode.mkdirSync(path.join(chestnutDir, 'logs'), { recursive: true });
    fsNode.mkdirSync(clawsDir, { recursive: true });
    fsNode.mkdirSync(subscriptionsDir, { recursive: true });

    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({
      watchdog: { interval_ms: 5_000, claw_inactivity_timeout_ms: 300_000 },
      audit: { retention: { max_size_mb: null } },
    } as any);
    vi.mocked(getGlobalConfig).mockReturnValue({
      watchdog: { interval_ms: 5_000, claw_inactivity_timeout_ms: 300_000 },
      audit: { retention: { max_size_mb: null } },
    } as any);
    vi.mocked(getChestnutFs).mockImplementation(
      (factory: (baseDir: string) => FileSystem) => factory(chestnutDir),
    );

    clawStateAPI.lastInactivityNotified.clear();
    clawStateAPI.inactivityNotifyCount.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fsNode.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Reverse 1: subscription-store outer listSync EACCES ────────────────────

  it('反向 1：subscription-store outer listSync EACCES → emit SUBSCRIPTION_DIR_LIST_FAILED + return []', () => {
    const eaccesErr = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const mockFs = {
      listSync: vi.fn().mockImplementation((p: string, _opts?: unknown) => {
        if (p === 'watchdog-subscriptions') throw eaccesErr;
        return [];
      }),
    };
    const mockAudit = makeMockAudit();

    const result = listSubscriptions(mockFs as any, mockAudit);

    expect(result).toEqual([]);
    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_DIR_LIST_FAILED,
      // phase 696: src 加 dir col
      expect.stringContaining('dir='),
      expect.stringContaining('error='),
    );
  });

  // ── Reverse 2: subscription-store outer listSync ENOENT ────────────────────

  it('反向 2：subscription-store outer listSync ENOENT → 0 audit + return []', () => {
    const enoentErr = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const mockFs = {
      listSync: vi.fn().mockImplementation((p: string, _opts?: unknown) => {
        if (p === 'watchdog-subscriptions') throw enoentErr;
        return [];
      }),
    };
    const mockAudit = makeMockAudit();

    const result = listSubscriptions(mockFs as any, mockAudit);

    expect(result).toEqual([]);
    expect(mockAudit.write).not.toHaveBeenCalled();
  });

  // ── Reverse 3: claw inactivity check throw ─────────────────────────────────

  it('反向 3：claw inactivity check throw → emit CLAW_INACTIVITY_CHECK_FAILED', async () => {
    const clawId = 'claw-X';
    fsNode.mkdirSync(path.join(clawsDir, clawId, 'contract', 'active', '1740000000000-foo'), { recursive: true });

    const mockAudit = makeMockAudit();
    const mockPm = { isAlive: vi.fn().mockReturnValue(true) } as unknown as import('../../src/foundation/process-manager/index.js').ProcessManager;

    await expect(maybeCronClawInactivity(mockPm, mockAudit as any, fsFactory)).resolves.not.toThrow();

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CLAW_INACTIVITY_CHECK_FAILED,
      expect.stringContaining('claw='),
      expect.stringContaining('error='),
    );
  });

  // ── Reverse 4: subscription process throw → no consume ─────────────────────

  it('反向 4：subscription process throw → emit SUBSCRIPTION_PROCESS_FAILED + 不 consume', async () => {
    const clawId = 'claw-Y';
    fsNode.mkdirSync(path.join(clawsDir, clawId, 'contract', 'active', '1740000000000-foo'), { recursive: true });
    fsNode.writeFileSync(
      path.join(subscriptionsDir, `${clawId}.json`),
      JSON.stringify({ subscribed_at: 1, threshold_ms: 1 }),
    );

    const mockAudit = makeMockAudit();
    const mockPm = { isAlive: vi.fn().mockReturnValue(true) } as unknown as import('../../src/foundation/process-manager/index.js').ProcessManager;

    await expect(maybeCronCheckSubscriptions(mockPm, mockAudit as any, fsFactory)).resolves.not.toThrow();

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_PROCESS_FAILED,
      expect.stringContaining('claw='),
      expect.stringContaining('error='),
    );
    expect(fsNode.existsSync(path.join(subscriptionsDir, `${clawId}.json`))).toBe(true);
  });
});
