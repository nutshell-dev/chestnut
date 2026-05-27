import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assemble } from '../../src/assembly/assemble.js';

// ============================================================================
// Shared mocks (mirror assemble-evolution-guard.test.ts pattern)
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
  AuditWriter: vi.fn(() => ({ write: mockAuditWrite })),
  AUDIT_FILE: 'audit.tsv',
}));

vi.mock('../../src/foundation/snapshot/index.js', () => ({
  Snapshot: vi.fn(() => mockSnapshot),
  createSnapshot: vi.fn(() => mockSnapshot),
}));

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

vi.mock('../../src/core/cron/runner.js', () => ({
  CronRunner: vi.fn(() => mockCronRunner),
  parseSchedule: vi.fn((s: string) => s),
}));

vi.mock('../../src/core/cron/jobs/disk-monitor.js', () => ({
  runDiskMonitor: vi.fn(),
  DISK_MONITOR_CRON_TIMEOUT_MS: 60_000,
}));

vi.mock('../../src/core/cron/jobs/llm-stats.js', () => ({
  runLlmStats: vi.fn(),
  LLM_STATS_CRON_TIMEOUT_MS: 60_000,
}));

const mockMemorySystem = {
  runDeepDream: vi.fn(),
  runRandomDream: vi.fn(),
};

vi.mock('../../src/core/memory/index.js', () => ({
  createMemorySystem: vi.fn(() => mockMemorySystem),
  memorySearchTool: { name: 'memory_search' },
}));

vi.mock('../../src/core/contract/jobs/contract-observer.js', () => ({
  runContractObserver: vi.fn(),
  CONTRACT_OBSERVER_CRON_TIMEOUT_MS: 5 * 60_000,
}));

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

vi.mock('../../src/foundation/skill-system/registry.js', () => ({
  SkillSystem: vi.fn(() => ({ loadAll: vi.fn().mockResolvedValue(undefined), getSkills: vi.fn(() => []) })),
}));

vi.mock('../../src/core/evolution-system/index.js', () => ({
  EvolutionSystem: vi.fn(() => ({ runRetroForContract: vi.fn().mockResolvedValue(undefined), init: vi.fn().mockResolvedValue(undefined) })),
  createEvolutionSystem: vi.fn(() => ({
    runRetroForContract: vi.fn(async (_contractId: string, ctx: any) => {
      // Simulate the real path where factory is called (evolution-system/system.ts:232)
      ctx.clawContractManagerFactory('/tmp/test-claw', 'test-claw', {} as any);
      return { status: 'ok' };
    }),
    init: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Capture callback registered to contractManager.onContractCompleted
let capturedContractCallback: ((contractId: string) => Promise<void>) | undefined;

vi.mock('../../src/core/contract/manager.js', () => ({
  ContractSystem: vi.fn(() => ({
    setOnNotify: vi.fn(),
    loadPaused: vi.fn(),
    resume: vi.fn(),
    onContractCompleted: vi.fn((cb: (contractId: string) => Promise<void>) => {
      capturedContractCallback = cb;
      return () => {};
    }),
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
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

vi.mock('../../src/foundation/messaging/index.js', () => {
  const MockInboxWriter = vi.fn().mockImplementation(() => ({
    write: vi.fn().mockResolvedValue(undefined),
    writeSync: vi.fn(),
  }));
  (MockInboxWriter as any).readMeta = vi.fn();
  (MockInboxWriter as any).__internal_create = vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined), writeSync: vi.fn() }));
  return {
    InboxReader: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined), drainInbox: vi.fn(() => []), drainAndDeliver: vi.fn(() => ({ entries: [], handles: [] })), markDone: vi.fn(), markFailed: vi.fn(), ack: vi.fn(), nack: vi.fn() })),
    OutboxWriter: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
    InboxWriter: MockInboxWriter,
    createInboxReader: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined), drainInbox: vi.fn(() => []), drainAndDeliver: vi.fn(() => ({ entries: [], handles: [] })), markDone: vi.fn(), markFailed: vi.fn(), ack: vi.fn(), nack: vi.fn() })),
    createOutboxWriter: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
    createMessaging: vi.fn(() => ({ drainOutboxes: vi.fn().mockResolvedValue({ delivered: 0, failed: 0 }) })),
    makeInboxPath: vi.fn((dir: string) => dir),
    makeOutboxPath: vi.fn((_clawId: string, clawDir: string) => clawDir + '/outbox/pending'),
    readInboxFileMeta: vi.fn(),
  };
});

vi.mock('../../src/foundation/dialog-store/index.js', () => ({
  DialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), systemPrompt: '' })),
  createDialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), restorePrefix: vi.fn() })),
}));

vi.mock('../../src/foundation/config/index.js', () => ({
  buildLLMConfig: vi.fn(() => ({ provider: 'mock' })),
}));


// ============================================================================
// Spy createContractSystem to capture 6th arg
// ============================================================================
let createContractSystemCalls: any[][] = [];

vi.mock('../../src/core/contract/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/contract/index.js')>();
  return {
    ...mod,
    createContractSystem: vi.fn((...args: any[]) => {
      createContractSystemCalls.push(args);
      return mod.createContractSystem(...args);
    }),
  };
});

// ============================================================================
// Tests
// ============================================================================
describe('assemble evolution clawContractManagerFactory toolRegistry (phase 951)', () => {
  const baseConfig = {
    identity: 'motion' as const,
    clawId: 'motion',
    clawDir: '/tmp/motion',
    globalConfig: {
      audit: { retention: { max_size_mb: null as number | null } },
      stream: { retention: { max_files: null as number | null, max_days: null as number | null } },
      cron: {
        enabled: true,
        tick_interval_ms: 1000,
        jobs: {},
      },
      watchdog: { disk_warning_mb: 500 },
      motion: {
        heartbeat_interval_ms: 5000,
        max_steps: 30,
        max_concurrent_tasks: 5,
      },
      tool_timeout_ms: 30000,
    },
    clawConfig: null as unknown as { max_steps: number; tool_profile: string; subagent_max_steps: number; max_concurrent_tasks: number } | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
    mockProcessManager.acquireLock.mockReturnValue(undefined);
    capturedContractCallback = undefined;
    createContractSystemCalls = [];
  });

  it('clawContractManagerFactory passes main toolRegistry to createContractSystem', async () => {
    await assemble(baseConfig);

    expect(capturedContractCallback).toBeDefined();
    await capturedContractCallback!('test-contract-id');

    // There should be at least 2 createContractSystem calls:
    // 1. main contract manager (line 233)
    // 2. factory call inside runRetroForContract
    expect(createContractSystemCalls.length).toBeGreaterThanOrEqual(2);

    // Find the main call (deps.clawDir === clawDir)
    const mainCall = createContractSystemCalls.find((args) => args[0].clawDir === baseConfig.clawDir);
    expect(mainCall).toBeDefined();
    const mainRegistry = mainCall![0].toolRegistry;

    // Find the factory call (deps.clawDir !== clawDir)
    const factoryCall = createContractSystemCalls.find((args) => args[0].clawDir !== baseConfig.clawDir && args[0].toolRegistry !== undefined);
    expect(factoryCall).toBeDefined();
    const factoryRegistry = factoryCall![0].toolRegistry;

    // The factory must pass the SAME main registry instance (not a new empty one)
    expect(factoryRegistry).toBe(mainRegistry);
  });
});
