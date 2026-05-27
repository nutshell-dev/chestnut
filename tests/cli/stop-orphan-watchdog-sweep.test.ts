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
vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    loadGlobalConfig: vi.fn(),
    getGlobalConfigPath: vi.fn(() => '/tmp/test/.clawforum/config.yaml'),
    getNamedSubrootDir: vi.fn(() => '/tmp/test/.clawforum/motion'),
  };
});

vi.mock('../../src/watchdog/watchdog.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/cli/commands/motion.js', () => ({
  stopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    kill: vi.fn(),
  };
});

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    isAlive: vi.fn().mockReturnValue(false),
    stop: vi.fn().mockResolvedValue(undefined),
    findProcesses: mockFindProcesses,
  })),
}));

vi.mock('../../src/watchdog/watchdog-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-context.js')>();
  return {
    ...actual,
    getWatchdogEntryPath: vi.fn(() => '/fake/watchdog-entry.js'),
    getAuditWriter: vi.fn(() => ({ write: mockAuditState.write })),
  };
});

vi.mock('../../src/foundation/audit/index.js', () => ({
  createSystemAudit: mockCreateSystemAudit,
  createAuditWriter: vi.fn(),
}));

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

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('stop — orphan watchdog sweep (phase 1269 sub-4)', () => {
  beforeEach(() => {
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
