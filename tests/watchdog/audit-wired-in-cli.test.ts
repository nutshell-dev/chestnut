import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { getNamedSubrootDir } from '../../src/foundation/claw-identity/index.js';
import { readWorkspaceWatchdogConfig } from '../../src/watchdog/workspace-config.js';
import { setAuditWriter, getAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { createWatchdogActionAudit } from '../../src/watchdog/audit-wiring.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { makeMockAudit } from '../helpers/audit.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockKill = vi.hoisted(() => vi.fn());

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

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    findProcesses: mockFindProcesses,
  })),
}));

// Phase 1878 Step I: CLI 侧 audit wiring 归位——createWatchdogActionAudit 窄能力
// （action scoped own + dispose；已安装则非 owner 复用；构造 fail-soft）。
describe('watchdog action audit in CLI (phase 1878 Step I)', () => {
  let tmpDir: string;
  let chestnutDir: string;
  const originalConsoleError = console.error;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    _resetWatchdogContextForTest();
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `wd-audit-wire-${randomUUID()}`);
    chestnutDir = path.join(tmpDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    vi.mocked(getNamedSubrootDir).mockReturnValue(path.join(chestnutDir, 'motion'));
    vi.mocked(readWorkspaceWatchdogConfig).mockReturnValue({
      interval_ms: 30_000, heartbeat_stale_timeout_ms: 180_000,
    });

    setAuditWriter(null);

    mockFindProcesses.mockReturnValue([]);
    mockKill.mockImplementation(() => {});
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sweepOrphanWatchdogs scoped-wires audit when not installed, writes ORPHAN_SWEEP_KILLED, disposes at end', async () => {
    // phase 287: fake timers skip the 1000ms SWEEP_GRACE_MS wait inside orphan-sweep
    vi.useFakeTimers();
    try {
      const { sweepOrphanWatchdogs } = await import('../../src/watchdog/orphan-sweep.js');

      // Phase 1288 Step C: 预置 legacy 根 audit.tsv，验证切换后 legacy 不新增
      const legacyAuditPath = path.join(chestnutDir, 'audit.tsv');
      const legacyLines = '2024-01-01T00:00:00Z\tseq=1\tlegacy_event\n';
      fs.writeFileSync(legacyAuditPath, legacyLines);

      mockFindProcesses.mockReturnValue([2000]);

      const sweepPromise = sweepOrphanWatchdogs(fsFactory, { excludePid: null }, { kill: mockKill });
      await vi.advanceTimersByTimeAsync(1001);
      const killed = await sweepPromise;

      expect(killed).toEqual([2000]);
      // Phase 1878 Step I: scoped own + 终态 dispose——sweep 结束后无悬挂安装
      expect(getAuditWriter()).toBeNull();

      // Phase 1288 Step C: 新根事件真实落 audit/audit.tsv（dispose 前已同步落盘）
      const auditPath = path.join(chestnutDir, 'audit', 'audit.tsv');
      expect(fs.existsSync(auditPath)).toBe(true);
      const content = fs.readFileSync(auditPath, 'utf8');
      expect(content).toContain(WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED);
      // legacy 根 audit.tsv 原样保留、不新增
      expect(fs.readFileSync(legacyAuditPath, 'utf8')).toBe(legacyLines);
    } finally {
      vi.useRealTimers();
    }
  });

  it('owner lifecycle: create installs writer; dispose releases + uninstalls; double dispose idempotent', () => {
    const handle = createWatchdogActionAudit(fsFactory);
    expect(handle.audit).not.toBeNull();
    expect(getAuditWriter()).toBe(handle.audit);

    const disposeSpy = vi.spyOn(handle.audit!, 'dispose');
    handle.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(getAuditWriter()).toBeNull();

    expect(() => handle.dispose()).not.toThrow();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('existing writer (daemon process / prior action install): non-owner handle, dispose does not touch it', () => {
    const mockWriter = makeMockAudit();
    const disposeSpy = vi.fn();
    (mockWriter as { dispose?: () => void }).dispose = disposeSpy;
    setAuditWriter(mockWriter);

    const handle = createWatchdogActionAudit(fsFactory);

    expect(handle.audit).toBe(mockWriter);
    handle.dispose();
    // 非 owner：安装保留、writer 未被释放
    expect(getAuditWriter()).toBe(mockWriter);
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(mockWriter.write).not.toHaveBeenCalled();
  });

  it('construction fail-soft when chestnut dir unreachable: audit=null + console.error, dispose safe', () => {
    vi.mocked(getNamedSubrootDir).mockImplementation(() => {
      throw new Error('fs unreachable');
    });

    let handle: ReturnType<typeof createWatchdogActionAudit>;
    expect(() => { handle = createWatchdogActionAudit(fsFactory); }).not.toThrow();
    expect(handle!.audit).toBeNull();
    expect(getAuditWriter()).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      'Failed to wire watchdog audit in CLI:',
      expect.any(Error),
    );
    expect(() => handle!.dispose()).not.toThrow();
  });
});
