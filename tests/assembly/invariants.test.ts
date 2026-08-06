/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - assemble-evolution-toolregistry.test.ts
 *  - assemble-dream-trigger-guard.test.ts
 *  - assemble-evolution-guard.test.ts
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { buildTestGlobalConfig } from '../helpers/global-config.js';

// 重依赖延迟加载：collect 段不执行 assembly 大图顶层代码
let assemble: typeof import('../../src/assembly/assemble.js').assemble;
let createMemorySystem: typeof import('../../src/core/memory/index.js').createMemorySystem;
let CronRunner: typeof import('../../src/foundation/cron/runner.js').CronRunner;
let createEvolutionSystem: typeof import('../../src/core/evolution-system/index.js').createEvolutionSystem;

beforeAll(async () => {
  const assembleMod = await import('../../src/assembly/assemble.js');
  assemble = assembleMod.assemble;
  const memoryMod = await import('../../src/core/memory/index.js');
  createMemorySystem = memoryMod.createMemorySystem;
  const cronMod = await import('../../src/foundation/cron/runner.js');
  CronRunner = cronMod.CronRunner;
  const evolutionMod = await import('../../src/core/evolution-system/index.js');
  createEvolutionSystem = evolutionMod.createEvolutionSystem;
});

const { mockSkillFactory } = vi.hoisted(() => ({
  mockSkillFactory: vi.fn(() => ({
    loadAll: vi.fn().mockResolvedValue(undefined),
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    getSkills: vi.fn(() => []),
  })),
}));

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
const mockProcessManager = {};
const mockCronRunner = {
  start: vi.fn(),
  stop: vi.fn(),
};
const mockHeartbeat = {};
const mockMemorySystem = {
  runDeepDream: vi.fn(),
  runRandomDream: vi.fn(),
};

// Mutable state shared across the heavy assemble-graph describe blocks,
// referenced by module-level vi.mock factories.
let capturedContractCallback: ((contractId: string) => Promise<void>) | undefined;
let createContractSystemCalls: any[][] = [];

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
  SNAPSHOT_FILE_ROUTING: {},
}));

vi.mock('../../src/assembly/config/snapshot-patterns.js', () => ({
  SNAPSHOT_IGNORE_PATTERNS: ['.git', 'node_modules'],
}));

vi.mock('../../src/foundation/stream/writer.js', () => ({
  StreamWriter: vi.fn(() => mockStreamWriter),
  createStreamWriter: vi.fn(() => mockStreamWriter),
}));

vi.mock('../../src/foundation/stream/index.js', () => ({
  createStreamWriter: vi.fn(() => mockStreamWriter),
  STREAM_FILE_ROUTING: {},
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

vi.mock('../../src/foundation/cron/runner.js', () => {
  const CronRunner = vi.fn(() => mockCronRunner);
  return {
    CronRunner,
    parseSchedule: vi.fn((s: string) => s),
    createCronRunner: vi.fn((jobs: any, sink: any) => new (CronRunner as any)(jobs, sink)),
  };
});

vi.mock('../../src/core/memory/index.js', () => ({
  createMemorySystem: vi.fn(() => mockMemorySystem),
  memorySearchTool: { name: 'memory_search' },
  MEMORY_DIR: 'memory',
  MEMORY_FILE_ROUTING: {},
}));

let capturedContractObserverDeps: any;
const capturedTaskSystems: any[] = [];

vi.mock('../../src/core/contract/jobs/contract-observer.js', () => {
  const mockRunContractObserver = vi.fn();
  return {
    runContractObserver: mockRunContractObserver,
    CONTRACT_OBSERVER_CRON_TIMEOUT_MS: 5 * 60_000,
    createContractObserverJob: vi.fn((deps, globalConfig) => {
      capturedContractObserverDeps = deps;
      return {
        name: 'contract-observer',
        enabled: globalConfig.cron.jobs.contract_observer.enabled,
        schedule: globalConfig.cron.jobs.contract_observer.schedule,
        handler: (signal: AbortSignal) => mockRunContractObserver({ ...deps, signal }),
        timeoutMs: 5 * 60_000,
      };
    }),
  };
});

vi.mock('../../src/foundation/llm-orchestrator/orchestrator.js', () => ({
  LLMOrchestratorImpl: vi.fn(() => ({ close: vi.fn(), healthCheck: vi.fn(), getProviderInfo: vi.fn() })),
  createLLMOrchestrator: vi.fn(() => ({ close: vi.fn(), healthCheck: vi.fn(), getProviderInfo: vi.fn() })),
}));

vi.mock('../../src/foundation/monitor/monitor.js', () => ({
  JsonlLogger: vi.fn(() => ({ log: vi.fn(), close: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/registry.js', () => ({
  ToolRegistryImpl: vi.fn(() => ({ register: vi.fn(), getForProfile: vi.fn(() => []), getAll: vi.fn(() => []), formatForLLM: vi.fn(), unregister: vi.fn() })),
  createToolRegistry: vi.fn(() => ({ register: vi.fn(), getForProfile: vi.fn(() => []), getAll: vi.fn(() => []), formatForLLM: vi.fn(), unregister: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/executor.js', () => ({
  ToolExecutorImpl: vi.fn(() => ({ execute: vi.fn() })),
  createToolExecutor: vi.fn((...args: any[]) => new (vi.fn(() => ({ execute: vi.fn() })) as any)(...args)),
}));

vi.mock('../../src/core/evolution-system/index.js', () => ({
  EvolutionSystem: vi.fn(() => ({ notifyContractCompleted: vi.fn().mockResolvedValue({ status: 'submitted' }), init: vi.fn().mockResolvedValue(undefined) })),
  createEvolutionSystem: vi.fn(() => ({
    notifyContractCompleted: vi.fn(async (_contractId: string, ctx: any) => {
      // Simulate the real path where factory is called (evolution-system/system.ts)
      ctx.clawContractManagerFactory('/tmp/test-claw', 'test-claw', {} as any);
      return { status: 'submitted' };
    }),
    registerRetrospective: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
  })),
  DISPATCH_SKILLS_PATH: 'clawspace/dispatch-skills',
  DISPATCH_SKILLS_SUBDIR: 'dispatch-skills',
}));

vi.mock('../../src/core/contract/manager.js', () => {
  const ContractSystem = vi.fn(() => ({
    setOnNotify: vi.fn(),
    loadPaused: vi.fn(),
    resume: vi.fn(),
    onContractCompleted: vi.fn((cb: (contractId: string) => Promise<void>) => {
      capturedContractCallback = cb;
      return () => {};
    }),
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    registerCreatePolicy: vi.fn(),
    createSubmitSubtaskTool: vi.fn(() => ({ name: 'submit_subtask', profiles: ['full'] })),
  }));
  return {
    ContractSystem,
    createContractSystem: vi.fn((deps: any) => new (ContractSystem as any)(deps)),
  };
});

vi.mock('../../src/core/async-task-system/system.js', () => {
  const AsyncTaskSystem = vi.fn(() => {
    const instance = { initialize: vi.fn().mockResolvedValue(undefined), startDispatch: vi.fn(), shutdown: vi.fn(), addPostProcessor: vi.fn(), setMainDialogStore: vi.fn() };
    capturedTaskSystems.push(instance);
    return instance;
  });
  return {
    AsyncTaskSystem,
    createAsyncTaskSystem: vi.fn((clawDir: any, fs: any, options: any) => new (AsyncTaskSystem as any)(clawDir, fs, options)),
  };
});

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
    createInboxMessageTypeRegistry: vi.fn(() => {
      const map = new Map();
      return {
        register: vi.fn((declaration: { type: string; rendering: unknown }) => { map.set(declaration.type, declaration.rendering); }),
        resolve: vi.fn((type: string) => map.get(type)),
      };
    }),
    registerInboxMessageTypes: vi.fn(),
  };
});

vi.mock('../../src/foundation/dialog-store/index.js', () => ({
  DialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), systemPrompt: '' })),
  createDialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), restorePrefix: vi.fn() })),
  DIALOG_DIR: 'dialog',
  DIALOG_ARCHIVE_DIR: 'dialog/archive',
  CURRENT_DIALOG_FILE: 'current.json',
}));

vi.mock('../../src/assembly/config/config-load.js', () => {
  // phase 1300 Step A: owner 名称改为 resolveLLMConfig；同一 mock fn 同时挂在
  // 新旧两名下，保持 buildLLMConfig 断言与 mockImplementationOnce 语义不变。
  const llmConfigFn = vi.fn(() => ({ provider: 'mock' }));
  return { buildLLMConfig: llmConfigFn, resolveLLMConfig: llmConfigFn };
});

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

describe('assemble-evolution-toolregistry', () => {
// ============================================================================
// Shared mocks (mirror assemble-evolution-guard.test.ts pattern)
// ============================================================================

// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 迁 assembly/snapshot-patterns

// ============================================================================
// Tests
// ============================================================================
describe('assemble evolution clawContractManagerFactory toolRegistry (phase 951)', () => {
  const baseConfig = {
    identity: 'motion' as const,
    clawId: 'motion',
    clawDir: '/tmp/motion',
    globalConfig: buildTestGlobalConfig({
      cron: { enabled: true, tick_interval_ms: 1000 },
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
    capturedContractCallback = undefined;
    capturedContractObserverDeps = undefined;
    createContractSystemCalls = [];
  });

  it('clawContractManagerFactory passes main toolRegistry to createContractSystem', async () => {
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    expect(capturedContractCallback).toBeDefined();
    await capturedContractCallback!('test-contract-id');

    // There should be at least 2 createContractSystem calls:
    // 1. main contract manager (line 233)
    // 2. factory call inside notifyContractCompleted
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
});

describe('assemble-dream-trigger-guard', () => {
// phase 279: hoist 3 dyn imports

// ============================================================================
// Shared mocks
// ============================================================================

// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 迁 assembly/snapshot-patterns

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
  });

  it('handler returns early when memorySystem is undefined (non-motion claw)', async () => {
    (createMemorySystem as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    const jobs = (CronRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dreamJob = jobs.find((j: any) => j.name === 'dream-trigger');
    expect(dreamJob).toBeDefined();

    // handler 应静默返回，不抛 NPE
    await expect(dreamJob.handler()).resolves.toBeUndefined();

    expect(mockMemorySystem.runDeepDream).not.toHaveBeenCalled();
    expect(mockMemorySystem.runRandomDream).not.toHaveBeenCalled();
  });

  it('handler invokes memorySystem methods when motion claw assembles', async () => {
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    const jobs = (CronRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dreamJob = jobs.find((j: any) => j.name === 'dream-trigger');
    expect(dreamJob).toBeDefined();

    await dreamJob.handler();

    expect(mockMemorySystem.runDeepDream).toHaveBeenCalledTimes(1);
    expect(mockMemorySystem.runRandomDream).toHaveBeenCalledTimes(1);
  });
});
});

describe('assemble-evolution-guard', () => {
  // phase 280: hoist 2 dyn

// ============================================================================
// Shared mocks
// ============================================================================

// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 迁 assembly/snapshot-patterns

// ============================================================================
// Tests
// ============================================================================
describe('contractManager onContractCompleted NPE guard (phase 620)', () => {
  const baseConfig = {
    identity: 'motion' as const,
    clawId: 'motion',
    clawDir: '/tmp/motion',
    globalConfig: buildTestGlobalConfig({
      cron: { enabled: true, tick_interval_ms: 1000 },
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
    capturedContractCallback = undefined;
    capturedTaskSystems.length = 0;
  });

  it('does not throw when evolutionSystem missing (defensive guard)', async () => {
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).resolves.toBeDefined();
  });

  it('still calls notifyContractCompleted when evolutionSystem present (phase 1206 Step D)', async () => {
    const mockNotify = vi.fn().mockResolvedValue({ status: 'submitted' });
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      notifyContractCompleted: mockNotify,
      registerRetrospective: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
    });

    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    expect(capturedContractCallback).toBeDefined();
    await capturedContractCallback!('test-contract-id');

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('test-contract-id', expect.anything());

    // Phase 1206 Step D: contract completion triggers retro_triggered audit
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'retro_triggered',
      'contractId=test-contract-id',
      'source=motion_self',
      'status=submitted',
    );
  });

  it('rethrows the original error after audit when notifyContractCompleted rejects (phase 1206 Step E)', async () => {
    const mockNotify = vi.fn().mockRejectedValue(new Error('retro dispatch failed'));
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      notifyContractCompleted: mockNotify,
      registerRetrospective: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
    });

    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    expect(capturedContractCallback).toBeDefined();
    await expect(capturedContractCallback!('test-contract-id')).rejects.toThrow('retro dispatch failed');

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'contract_completed_handler_failed',
      'contractId=test-contract-id',
      expect.stringContaining('retro dispatch failed'),
    );

    // Phase 1206 Step E: motion-only registration; post-processor bound to evolutionSystem
    const taskSystem = capturedTaskSystems.at(-1);
    expect(taskSystem).toBeDefined();
    const retroPostProcessorCalls = taskSystem.addPostProcessor.mock.calls.filter(
      (c: any[]) => c[0] === 'summon-contract-extract' || c[0] === 'dispatch-contract-extract',
    );
    expect(retroPostProcessorCalls.length).toBe(2);
    const boundRegister = retroPostProcessorCalls[0][1];
    expect(typeof boundRegister).toBe('function');
  });
});
});




describe('assemble-evolution-stepE-boundaries', () => {
  const baseClawConfig = {
    max_steps: 30,
    tool_profile: 'full',
    subagent_max_steps: 10,
    max_concurrent_tasks: 5,
  };

  const motionBaseConfig = {
    identity: 'motion' as const,
    clawId: 'motion',
    clawDir: '/tmp/motion',
    globalConfig: buildTestGlobalConfig({
      cron: { enabled: true, tick_interval_ms: 1000 },
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

  const clawBaseConfig = {
    identity: 'claw' as const,
    clawId: 'claw-a',
    clawDir: '/tmp/claw-a',
    globalConfig: buildTestGlobalConfig({
      cron: { enabled: true, tick_interval_ms: 1000 },
      watchdog: { disk_warning_mb: 500 },
      motion: {
        heartbeat_interval_ms: 5000,
        max_steps: 30,
        max_concurrent_tasks: 5,
      },
      tool_timeout_ms: 30000,
    }),
    clawConfig: baseClawConfig,
  };

  function makeEvolutionSystemMock(overrides?: { notifyContractCompleted?: any }) {
    return {
      notifyContractCompleted: overrides?.notifyContractCompleted ?? vi.fn().mockResolvedValue({ status: 'submitted' }),
      registerRetrospective: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
    capturedContractCallback = undefined;
    capturedContractObserverDeps = undefined;
    capturedTaskSystems.length = 0;
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeEvolutionSystemMock());
  });

  afterEach(() => {
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('non-motion assembly does not register retrospective post-processor', async () => {
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => undefined);

    await assemble(clawBaseConfig, undefined, { createSkillSystem: mockSkillFactory });

    const taskSystem = capturedTaskSystems.at(-1);
    expect(taskSystem).toBeDefined();
    const retroPostProcessorCalls = taskSystem.addPostProcessor.mock.calls.filter(
      (c: any[]) => c[0] === 'summon-contract-extract' || c[0] === 'dispatch-contract-extract',
    );
    expect(retroPostProcessorCalls.length).toBe(0);
  });

  it('motion contractManager.onContractCompleted callback rethrows the original error', async () => {
    const mockNotify = vi.fn().mockRejectedValue(new Error('motion self callback failed'));
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeEvolutionSystemMock({ notifyContractCompleted: mockNotify }),
    );

    await assemble(motionBaseConfig, undefined, { createSkillSystem: mockSkillFactory });

    expect(capturedContractCallback).toBeDefined();
    await expect(capturedContractCallback!('test-contract-id')).rejects.toThrow('motion self callback failed');

    expect(mockAuditWrite).toHaveBeenCalledWith(
      'contract_completed_handler_failed',
      'contractId=test-contract-id',
      expect.stringContaining('motion self callback failed'),
    );
  });

  it('contract observer bridge callback rethrows the original error', async () => {
    const mockNotify = vi.fn().mockRejectedValue(new Error('observer bridge failed'));
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeEvolutionSystemMock({ notifyContractCompleted: mockNotify }),
    );

    await assemble(motionBaseConfig, undefined, { createSkillSystem: mockSkillFactory });

    expect(capturedContractObserverDeps).toBeDefined();
    expect(capturedContractObserverDeps.onCompletedContract).toBeDefined();
    await expect(capturedContractObserverDeps.onCompletedContract('claw-a', 'test-contract-id')).rejects.toThrow('observer bridge failed');

    expect(mockAuditWrite).toHaveBeenCalledWith(
      'contract_completed_handler_failed',
      'contractId=test-contract-id',
      'source=contract_observer',
      expect.stringContaining('observer bridge failed'),
    );
  });
});
