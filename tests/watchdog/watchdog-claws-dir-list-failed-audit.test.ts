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
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { makeMockAudit } from '../helpers/audit.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { setTimeout as setTimeoutP } from 'timers/promises';
import { getChestnutFs, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

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
import { getNamedSubrootDir } from '../../src/core/claw-topology/claw-instance-paths.js';
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
      interval_ms: 5_000, disk_warning_mb: 500, claw_inactivity_timeout_ms: 300_000,
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

  async function runLoopForOneTick(): Promise<void> {
    const mockPm = {
      getAliveStatus: vi.fn().mockReturnValue({ alive: true, reason: '' }),
      spawn: vi.fn().mockResolvedValue(9999),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../../src/foundation/process-manager/index.js').ProcessManager;
    vi.mocked(createProcessManagerForCLI).mockReturnValue(mockPm);

    auditWriteSpy = vi.spyOn(AuditWriter.prototype, 'write').mockImplementation(function(this: AuditWriter, type: string, ...cols: (string | number)[]) {
      // No-op: we inspect calls via spy, no real file I/O
    });

    const originalSetTimeout = vi.mocked(setTimeoutP);
    originalSetTimeout.mockImplementationOnce(async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      process.emit('SIGTERM');
      exitSpy.mockRestore();
    });
    try {
      await runWatchdogLoop(fsFactory, 'logs/daemon.log');
    } catch {
      // process.exit mock may throw — expected
    }
  }

  function getAuditCalls(): Array<[string, ...(string | number)[]]> {
    return auditWriteSpy?.mock.calls as Array<[string, ...(string | number)[]]> ?? [];
  }

  // ── Reverse 1: watchdog tick listSync EACCES ───────────────────────────────

  it('reverse 1: watchdog tick listSync EACCES → emit CLAWS_DIR_LIST_FAILED + daemon 不死', async () => {
    fs.mkdirSync(clawsDir, { recursive: true });

    const eaccesErr = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const listSyncSpy = vi.spyOn(NodeFileSystem.prototype, 'listSync').mockImplementation((p: string, _opts?: unknown) => {
      if (p === 'claws') throw eaccesErr;
      const realFs = new NodeFileSystem({ baseDir: chestnutDir });
      return realFs.listSync(p, _opts as any);
    });

    await runLoopForOneTick();

    const calls = getAuditCalls();
    expect(calls.some(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED)).toBe(true);
    expect(calls.some(([type, ...cols]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED && cols.some(c => String(c).includes('ctx=watchdog_tick')))).toBe(true);
    expect(calls.some(([type, ...cols]) => type === WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED && cols.some(c => String(c).includes('Permission denied')))).toBe(true);
    // daemon 不死 = watchdog_check 仍被 emit
    expect(calls.some(([type]) => type === 'watchdog_check')).toBe(true);

    listSyncSpy.mockRestore();
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
    // daemon 不死
    expect(calls.some(([type]) => type === 'watchdog_check')).toBe(true);
    // present= empty（treat as empty）
    expect(calls.some(([type, ...cols]) => type === 'watchdog_check' && cols.some(c => String(c).includes('present=')))).toBe(true);

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
  });

});
