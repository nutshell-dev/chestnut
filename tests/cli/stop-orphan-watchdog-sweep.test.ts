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
const mockCreateSystemAudit = vi.hoisted(() => vi.fn(() => ({
  write: mockAuditState.write,
})));

// ============================================================================
// Module mocks
// ============================================================================
vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
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
vi.mock('../../src/assembly/config/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/config-loader.js')>();
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

vi.mock('../../src/watchdog/watchdog.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
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
    createSystemAudit: mockCreateSystemAudit,
    createAuditWriter: vi.fn(),
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

describe('stop — orphan watchdog sweep (phase 1269 sub-4)', () => {
  beforeEach(() => {
    _resetWatchdogContextForTest();
    mockAuditState.clear();
    vi.clearAllMocks();
  });

  it('stopAllCommand sweeps orphan watchdogs + audits ORPHAN_SWEEP_KILLED', async () => {
    mockFindProcesses.mockReturnValue([1111, 2222]);
    mockCreateSystemAudit.mockReturnValue({ write: mockAuditState.write });

    await stopAllCommand({ fsFactory });

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
});
