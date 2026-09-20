import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Hoisted mock state
// ============================================================================
const mockAuditState = vi.hoisted(() => {
  const events: Array<[string, ...(string | number)[]]> = [];
  return {
    events,
    clear: () => { events.length = 0; },
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
});

const mockFindProcesses = vi.hoisted(() => vi.fn().mockReturnValue([99991, 99992]));
// phase 1879 Step D: stop.ts audit 创建经 actionAuditFor（无 scope 回落 createDirContext）——
// mock 目标随创建点统一迁移（返回 { fs, audit } 形状）。
const mockCreateDirContext = vi.hoisted(() => vi.fn(() => ({
  fs: {},
  audit: { write: mockAuditState.write },
})));

// ============================================================================
// Module mocks
// ============================================================================
vi.mock('../../src/foundation/claw-identity/instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/instance-paths.js')>();
  return {
    ...actual,
    getNamedSubrootDir: vi.fn(() => '/tmp/test/.chestnut/motion'),
  };
});
vi.mock('../../src/assembly/config/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/global-config-path.js')>();
  return {
    ...actual,
    getGlobalConfigPath: vi.fn(() => '/tmp/test/.chestnut/config.yaml'),
  };
});
vi.mock('../../src/foundation/config-store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config-store/index.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/watchdog/watchdog.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
  getWatchdogPid: vi.fn().mockReturnValue(null),
  isWatchdogAlive: vi.fn().mockReturnValue(false),
  removeWatchdogPid: vi.fn(),
}));

vi.mock('../../src/cli/commands/motion.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    isAlive: vi.fn().mockReturnValue(false),
    stop: vi.fn().mockResolvedValue(undefined),
    findProcesses: mockFindProcesses,
  })),
}));

// Mock process-exec to no-op kill/isAlive — avoid hitting real OS (CI may have
// system processes at low pids like 1111 causing EPERM throws → test flake).
// Previously without mock, kill(1111) threw EPERM on CI but ESRCH-silent on local dev.
vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    kill: vi.fn(),
    isAlive: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../../src/watchdog/watchdog-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-context.js')>();
  return {
    ...actual,
    getWatchdogEntryPath: vi.fn(() => '/fake/watchdog-entry.js'),
    getAuditWriter: vi.fn(() => ({
      write: mockAuditState.write,
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    })),
  };
});

vi.mock('../../src/foundation/audit/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/audit/index.js')>();
  return {
    ...actual,
    createDirContext: mockCreateDirContext,
    // Phase 1288 Step C: stop 根审计构造切到 createWorkspaceAudit（mock 防真实磁盘写入）
    createWorkspaceAudit: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readdirSync: vi.fn().mockReturnValue([]),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

// ============================================================================
// Imports (after mocks)
// ============================================================================
import { stopAllCommand } from '../../src/cli/commands/stop.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const stopDeps = { fsFactory, rootConfig: { loadGlobal: vi.fn() } };

describe('stop — orphan watchdog sweep (phase 1269 sub-4)', () => {
  beforeEach(() => {
    _resetWatchdogContextForTest();
    mockAuditState.clear();
    vi.clearAllMocks();
  });

  it('stopAllCommand sweeps orphan watchdogs + audits ORPHAN_SWEEP_KILLED', async () => {
    mockFindProcesses.mockReturnValue([1111, 2222]);
    mockCreateDirContext.mockReturnValue({ fs: {}, audit: { write: mockAuditState.write } });

    await stopAllCommand(stopDeps);

    const sweepEvents = mockAuditState.events.filter(e => e[0] === WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED);
    expect(sweepEvents).toHaveLength(1);
    expect(sweepEvents[0]).toEqual(
      expect.arrayContaining([
        WATCHDOG_AUDIT_EVENTS.ORPHAN_SWEEP_KILLED,
        'count=2',
        'pids=1111,2222',
        'kept=none',
      ]),
    );
  });

  it('RootConfig guard error propagates before process side effects', async () => {
    const sentinel = new Error('stop config sentinel');
    stopDeps.rootConfig.loadGlobal.mockImplementationOnce(() => { throw sentinel; });

    await expect(stopAllCommand(stopDeps)).rejects.toBe(sentinel);
    expect(mockFindProcesses).not.toHaveBeenCalled();
    expect(mockCreateDirContext).not.toHaveBeenCalled();
  });
});
