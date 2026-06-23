import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSkillFactory } = vi.hoisted(() => ({
  mockSkillFactory: vi.fn(() => ({ loadAll: vi.fn().mockResolvedValue(undefined), getSkills: vi.fn(() => []) })),
}));
import { assemble } from '../../src/assembly/assemble.js';
import { buildTestGlobalConfig } from '../helpers/global-config.js';
// phase 279: hoist 3 dyn imports
import { createMemorySystem } from '../../src/core/memory/index.js';
import { CronRunner } from '../../src/foundation/cron/runner.js';

// ============================================================================
// Shared mocks
// ============================================================================
const mockAuditWrite = vi.fn();
const mockRuntime = {
  stop: vi.fn().mockResolvedValue(undefined),
  getTaskSystem: vi.fn(() => ({})),
};
const mockStreamWriter = {
  open: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
};
const mockSnapshot = {
  init: vi.fn(),
  commit: vi.fn(),
};
const mockProcessManager = {
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
};
const mockCronRunner = {
  start: vi.fn(),
  stop: vi.fn(),
};
const mockHeartbeat = {};

vi.mock('../../src/foundation/audit/writer.js', () => ({
  AuditWriter: vi.fn(() => ({
    write: mockAuditWrite,
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  })),
  AUDIT_FILE: 'audit.tsv',
}));

vi.mock('../../src/foundation/snapshot/index.js', () => ({
  Snapshot: vi.fn(() => mockSnapshot),
  createSnapshot: vi.fn(() => mockSnapshot),
}));

// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 迁 assembly/snapshot-patterns
vi.mock('../../src/assembly/snapshot-patterns.js', () => ({
  SNAPSHOT_IGNORE_PATTERNS: ['.git', 'node_modules'],
}));

vi.mock('../../src/foundation/stream/writer.js', () => ({
  StreamWriter: vi.fn(() => mockStreamWriter),
}));

vi.mock('../../src/foundation/stream/index.js', () => ({
  createStreamWriter: vi.fn(() => mockStreamWriter),
}));

vi.mock('../../src/foundation/fs/node-fs.js', () => ({
  NodeFileSystem: vi.fn(() => ({
    ensureDir: vi.fn().mockResolvedValue(undefined),
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ size: 0 })),
    readBytesSync: vi.fn(() => Buffer.from('')),
  })),
}));

vi.mock('../../src/assembly/cleanup.js', () => ({
  cleanupOrphanedTemp: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/foundation/process-manager/agent-factory.js', () => ({
  createAgentProcessManager: vi.fn(() => mockProcessManager),
}));

vi.mock('../../src/core/runtime/index.js', () => {
  const HeartbeatCtor = vi.fn(() => mockHeartbeat);
  return {
    Runtime: vi.fn(() => mockRuntime),
    createRuntime: vi.fn(() => mockRuntime),
    buildMotionSystemPrompt: vi.fn(() => Promise.resolve('')),
    Heartbeat: HeartbeatCtor,
    createHeartbeat: vi.fn((...args: any[]) => new (HeartbeatCtor as any)(...args)),
  };
});

vi.mock('../../src/foundation/cron/runner.js', () => ({
  CronRunner: vi.fn(() => mockCronRunner),
  parseSchedule: vi.fn((s: string) => s),
}));

vi.mock('../../src/foundation/cron/jobs/disk-monitor.js', () => {
  const mockRunDiskMonitor = vi.fn();
  return {
    runDiskMonitor: mockRunDiskMonitor,
    DISK_MONITOR_CRON_TIMEOUT_MS: 60_000,
    createDiskMonitorJob: vi.fn((deps, globalConfig) => ({
      name: 'disk-monitor',
      enabled: globalConfig.cron.jobs.disk_monitor.enabled,
      schedule: globalConfig.cron.jobs.disk_monitor.schedule,
      handler: (signal: AbortSignal) => mockRunDiskMonitor({ ...deps, signal }),
      timeoutMs: 60_000,
    })),
  };
});

vi.mock('../../src/foundation/cron/jobs/llm-stats.js', () => {
  const mockRunLlmStats = vi.fn();
  return {
    runLlmStats: mockRunLlmStats,
    LLM_STATS_CRON_TIMEOUT_MS: 60_000,
    createLlmStatsJob: vi.fn((deps, globalConfig) => ({
      name: 'llm-stats',
      enabled: globalConfig.cron.jobs.llm_stats.enabled,
      schedule: globalConfig.cron.jobs.llm_stats.schedule,
      handler: (signal: AbortSignal) => mockRunLlmStats({ ...deps, signal }),
      timeoutMs: 60_000,
    })),
  };
});

const mockMemorySystem = {
  runDeepDream: vi.fn(),
  runRandomDream: vi.fn(),
};

vi.mock('../../src/core/memory/index.js', () => ({
  createMemorySystem: vi.fn(() => mockMemorySystem),
  memorySearchTool: { name: 'memory_search' },
  MEMORY_DIR: 'memory',
}));

vi.mock('../../src/core/contract/jobs/contract-observer.js', () => {
  const mockRunContractObserver = vi.fn();
  return {
    runContractObserver: mockRunContractObserver,
    CONTRACT_OBSERVER_CRON_TIMEOUT_MS: 5 * 60_000,
    createContractObserverJob: vi.fn((deps, globalConfig) => ({
      name: 'contract-observer',
      enabled: globalConfig.cron.jobs.contract_observer.enabled,
      schedule: globalConfig.cron.jobs.contract_observer.schedule,
      handler: (signal: AbortSignal) => mockRunContractObserver({ ...deps, signal }),
      timeoutMs: 5 * 60_000,
    })),
  };
});

vi.mock('../../src/foundation/llm-orchestrator/orchestrator.js', () => ({
  LLMOrchestratorImpl: vi.fn(() => ({ close: vi.fn(), healthCheck: vi.fn(), getProviderInfo: vi.fn() })),
}));

vi.mock('../../src/foundation/monitor/monitor.js', () => ({
  JsonlLogger: vi.fn(() => ({ log: vi.fn(), close: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/registry.js', () => ({
  ToolRegistryImpl: vi.fn(() => ({ register: vi.fn(), getForProfile: vi.fn(() => []), getAll: vi.fn(() => []), formatForLLM: vi.fn(), unregister: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/executor.js', () => ({
  ToolExecutorImpl: vi.fn(() => ({ execute: vi.fn() })),
  createToolExecutor: vi.fn((...args: any[]) => new (vi.fn(() => ({ execute: vi.fn() })) as any)(...args)),
}));

vi.mock('../../src/core/contract/manager.js', () => ({
  ContractSystem: vi.fn(() => ({ setOnNotify: vi.fn(), loadPaused: vi.fn(), resume: vi.fn(), onContractCompleted: vi.fn(() => () => {}), init: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), registerCreatePolicy: vi.fn() })),
}));

vi.mock('../../src/core/async-task-system/system.js', () => ({
  AsyncTaskSystem: vi.fn(() => ({ initialize: vi.fn().mockResolvedValue(undefined), startDispatch: vi.fn(), shutdown: vi.fn(), addPostProcessor: vi.fn(), setMainDialogStore: vi.fn() })),
}));

vi.mock('../../src/core/dialog/injector.js', () => ({
  ContextInjector: vi.fn(() => ({ buildSystemPrompt: vi.fn(), buildParts: vi.fn() })),
  createContextInjector: vi.fn((...args: any[]) => new (vi.fn(() => ({ buildSystemPrompt: vi.fn(), buildParts: vi.fn() })) as any)(...args)),
}));

vi.mock('../../src/foundation/tools/context.js', () => ({
  ExecContextImpl: vi.fn(() => ({ signal: undefined })),
}));

vi.mock('../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/messaging/index.js')>();
  const MockInboxWriter = vi.fn().mockImplementation(() => ({
    write: vi.fn().mockResolvedValue(undefined),
    writeSync: vi.fn(),
  }));
  (MockInboxWriter as any).readMeta = vi.fn();
  (MockInboxWriter as any).__internal_create = vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined), writeSync: vi.fn() }));
  return {
    ...actual,
    InboxReader: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined), drainInbox: vi.fn(() => []), drainAndDeliver: vi.fn(() => ({ entries: [], handles: [] })), markDone: vi.fn(), markFailed: vi.fn(), ack: vi.fn(), nack: vi.fn() })),
    OutboxWriter: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
    InboxWriter: MockInboxWriter,
    createInboxReader: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined), drainInbox: vi.fn(() => []), drainAndDeliver: vi.fn(() => ({ entries: [], handles: [] })), markDone: vi.fn(), markFailed: vi.fn(), ack: vi.fn(), nack: vi.fn() })),
    createOutboxWriter: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
    makeInboxPath: vi.fn((dir: string) => dir),
    makeOutboxPath: vi.fn((_clawId: string, clawDir: string) => clawDir + '/outbox/pending'),
    readInboxFileMeta: vi.fn(),
    createMessageFormatterRegistry: vi.fn(() => {
      const map = new Map();
      return {
        register: vi.fn((type, fn) => { map.set(type, fn); }),
        resolve: vi.fn((type) => map.get(type)),
      };
    }),
    registerMessagingFormatters: vi.fn(),
    formatUserInboxMessage: vi.fn(),
    formatGenericMessage: vi.fn(),
  };
});

vi.mock('../../src/foundation/dialog-store/index.js', () => ({
  DialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), systemPrompt: '' })),
  createDialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), restorePrefix: vi.fn() })),
  DIALOG_DIR: 'dialog',
  DIALOG_ARCHIVE_DIR: 'dialog/archive',
  CURRENT_DIALOG_FILE: 'current.json',
}));

vi.mock('../../src/assembly/config-load.js', () => ({
  buildLLMConfig: vi.fn(() => ({ provider: 'mock' })),
}));


// ============================================================================
// Tests
// ============================================================================
describe('Assembly — dream-trigger handler memorySystem guard (F-r72-asm-P0-2)', () => {
  const baseConfig = {
    identity: 'motion' as const,
    clawId: 'motion',
    clawDir: '/tmp/motion',
    globalConfig: buildTestGlobalConfig({
      cron: {
        enabled: true,
        tick_interval_ms: 1000,
        jobs: {
          dream_trigger: { enabled: true },
        },
      },
      watchdog: { disk_warning_mb: 500 },
      motion: {
        heartbeat_interval_ms: 5000,
        max_steps: 30,
        max_concurrent_tasks: 5,
      },
      tool_timeout_ms: 30000,
    }),
    clawConfig: null as unknown as { max_steps: number; tool_profile: string; subagent_max_steps: number; max_concurrent_tasks: number } | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
    mockProcessManager.acquireLock.mockReturnValue(undefined);
  });

  it('handler returns early when memorySystem is undefined (non-motion claw)', async () => {
    (createMemorySystem as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

    await assemble(baseConfig, { createSkillSystem: mockSkillFactory });

    const jobs = (CronRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dreamJob = jobs.find((j: any) => j.name === 'dream-trigger');
    expect(dreamJob).toBeDefined();

    // handler 应静默返回，不抛 NPE
    await expect(dreamJob.handler()).resolves.toBeUndefined();

    expect(mockMemorySystem.runDeepDream).not.toHaveBeenCalled();
    expect(mockMemorySystem.runRandomDream).not.toHaveBeenCalled();
  });

  it('handler invokes memorySystem methods when motion claw assembles', async () => {
    await assemble(baseConfig, { createSkillSystem: mockSkillFactory });

    const jobs = (CronRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dreamJob = jobs.find((j: any) => j.name === 'dream-trigger');
    expect(dreamJob).toBeDefined();

    await dreamJob.handler();

    expect(mockMemorySystem.runDeepDream).toHaveBeenCalledTimes(1);
    expect(mockMemorySystem.runRandomDream).toHaveBeenCalledTimes(1);
  });
});
