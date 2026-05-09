/**
 * stop — orphan cleanup silent → audit (P1.4)
 *
 * 验证点：
 * 1. kill TERM 失败时写 ORPHAN_SIGTERM_FAILED audit
 * 2. 外层 cleanup pipeline 失败时写 PROCESS_LIST_FAILED audit
 * 3. audit 构造失败时 fallback null + 不抛
 */
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

const mockKill = vi.hoisted(() => vi.fn());
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
    getMotionDir: vi.fn(() => '/tmp/test/.clawforum/motion'),
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
    kill: mockKill,
  };
});

vi.mock('../../src/cli/utils/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    isAlive: vi.fn().mockReturnValue(false),
    stop: vi.fn().mockResolvedValue(undefined),
    findProcesses: mockFindProcesses,
  })),
}));

vi.mock('../../src/foundation/fs/node-fs.js', () => ({
  NodeFileSystem: vi.fn().mockImplementation(function (this: any, opts: any) {
    this.baseDir = opts.baseDir;
  }),
}));

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
import { createSystemAudit } from '../../src/foundation/audit/index.js';

describe('stop — orphan cleanup silent → audit (P1.4)', () => {
  beforeEach(() => {
    mockAuditState.clear();
    vi.clearAllMocks();
  });

  it('kill TERM 失败时写 ORPHAN_SIGTERM_FAILED audit', async () => {
    mockKill.mockImplementation(() => {
      throw new Error('EPERM');
    });
    mockFindProcesses.mockReturnValue([1111, 2222]);
    mockCreateSystemAudit.mockReturnValue({ write: mockAuditState.write });

    await stopAllCommand();

    const sigtermEvents = mockAuditState.events.filter(e => e[0] === 'orphan_sigterm_failed');
    expect(sigtermEvents).toHaveLength(2);
    expect(sigtermEvents[0]).toEqual(
      expect.arrayContaining([
        'orphan_sigterm_failed',
        'pid=1111',
        'context=stop_all_orphan_cleanup',
        expect.stringContaining('reason=EPERM'),
      ]),
    );
    expect(sigtermEvents[1]).toEqual(
      expect.arrayContaining([
        'orphan_sigterm_failed',
        'pid=2222',
        'context=stop_all_orphan_cleanup',
        expect.stringContaining('reason=EPERM'),
      ]),
    );
  });

  it('外层 cleanup pipeline 失败时写 PROCESS_LIST_FAILED audit', async () => {
    mockKill.mockImplementation(() => {});
    mockFindProcesses.mockImplementation(() => {
      throw new Error('some pipeline error');
    });
    mockCreateSystemAudit.mockReturnValue({ write: mockAuditState.write });

    await stopAllCommand();

    const listFailedEvents = mockAuditState.events.filter(e => e[0] === 'process_list_failed');
    expect(listFailedEvents).toHaveLength(1);
    expect(listFailedEvents[0]).toEqual(
      expect.arrayContaining([
        'process_list_failed',
        'context=stop_all_cleanup_pipeline',
        expect.stringContaining('reason=some pipeline error'),
      ]),
    );
  });

  it('audit 构造失败时 fallback null + 不抛', async () => {
    mockKill.mockImplementation(() => {});
    mockFindProcesses.mockReturnValue([3333]);
    mockCreateSystemAudit.mockImplementation(() => {
      throw new Error('audit init failed');
    });

    // 不应抛错
    await expect(stopAllCommand()).resolves.not.toThrow();

    // audit 为 null，所以没有任何 audit 事件
    expect(mockAuditState.events).toHaveLength(0);
  });
});
