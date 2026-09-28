/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - assemble-evolution-toolregistry.test.ts
 *  - assemble-dream-trigger-guard.test.ts
 *  - assemble-evolution-guard.test.ts
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildTestGlobalConfig } from '../helpers/global-config.js';
import { makeMockCreateSkillVersions } from '../helpers/skill-versions.js';

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
  mockSkillFactory: vi.fn(function () {
    return {
      loadAll: vi.fn().mockResolvedValue(undefined),
      ensureLoaded: vi.fn().mockResolvedValue(undefined),
      getSkills: vi.fn(function () {
        return [];
      }),
    };
  }),
}));

// Phase 1919 Step B：dispatch 版本服务 DI 注入（隔离真实嵌套 Git / mock fs）
const mockCreateSkillVersions = makeMockCreateSkillVersions();

const mockAuditWrite = vi.fn();
const mockRuntime = {
  stop: vi.fn().mockResolvedValue(undefined),
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
const capturedContractSystems: any[] = [];
// phase 1869 Step G: RuntimeDependencies 捕获（装配面接线锁定）。
const capturedRuntimeDeps: any[] = [];

vi.mock('../../src/foundation/audit/writer.js', () => ({
  AuditWriter: vi.fn(function () {
    return {
      write: mockAuditWrite,
      preview: vi.fn(function (s: string) {
        return s;
      }),
      message: vi.fn(function (s: string) {
        return s;
      }),
      summary: vi.fn(function (s: string) {
        return s;
      }),
    };
  }),
  AUDIT_FILE: 'audit.tsv',
  TICK_RETENTION_DAYS: 30,
}));

vi.mock('../../src/foundation/snapshot/index.js', () => ({
  Snapshot: vi.fn(function () {
    return mockSnapshot;
  }),
  createSnapshot: vi.fn(function () {
    return mockSnapshot;
  }),
  SNAPSHOT_FILE_ROUTING: {},
}));

vi.mock('../../src/assembly/config/snapshot-patterns.js', () => ({
  SNAPSHOT_IGNORE_PATTERNS: ['.git', 'node_modules'],
}));

vi.mock('../../src/foundation/stream/writer.js', () => ({
  StreamWriter: vi.fn(function () {
    return mockStreamWriter;
  }),
  createStreamWriter: vi.fn(function () {
    return mockStreamWriter;
  }),
}));

vi.mock('../../src/foundation/stream/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/foundation/stream/index.js')>();
  return {
    ...mod,
    createStreamWriter: vi.fn(function () {
      return mockStreamWriter;
    }),
    STREAM_FILE_ROUTING: {},
  };
});

vi.mock('../../src/foundation/fs/node-fs.js', () => ({
  NodeFileSystem: vi.fn(function ({ baseDir }: { baseDir: string }) {
    return {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      ensureDirSync: vi.fn(),
      existsSync: vi.fn(function () {
        return false;
      }),
      statSync: vi.fn(function () {
        return { size: 0 };
      }),
      readBytesSync: vi.fn(function () {
        return Buffer.from('');
      }),
      // phase 1818: createClawPermissionChecker 构造期必需 canonical resolve capability，
      // mock 亦须提供（词法 join 即可——本文件断言与 containment 无关）
      resolve: vi.fn(function (p: string) {
        return path.isAbsolute(p) ? p : path.join(baseDir, p);
      }),
      // phase 1817: GuardedWrite 消费 realpath/writeAtomic/append——构造期校验一并要求
      realpath: vi.fn(async function (p: string) {
        return path.isAbsolute(p) ? p : path.join(baseDir, p);
      }),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockResolvedValue(undefined),
      // Phase 1826: LLM 恢复状态 owner session 构造期读取（默认 ENOENT = 首次启动）。
      readSync: vi.fn(function () {
        const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
      writeAtomicSync: vi.fn(),
      deleteSync: vi.fn(),
    };
  }),
}));

vi.mock('../../src/assembly/cleanup.js', () => ({
  cleanupOrphanedTemp: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/foundation/process-manager/agent-factory.js', () => ({
  createAgentProcessManager: vi.fn(function () {
    return mockProcessManager;
  }),
}));

vi.mock('../../src/core/runtime/index.js', async (importOriginal) => {
  const HeartbeatCtor = vi.fn(function () {
    return mockHeartbeat;
  });
  return {
    ...(await importOriginal<typeof import('../../src/core/runtime/index.js')>()),
    Runtime: vi.fn(function () {
      return mockRuntime;
    }),
    createRuntime: vi.fn(function (opts: { dependencies?: unknown }) {
      // phase 1869 Step G: 捕获 RuntimeDependencies 供装配面接线断言。
      capturedRuntimeDeps.push(opts?.dependencies);
      return mockRuntime;
    }),
    buildMotionSystemPrompt: vi.fn(function () {
      return Promise.resolve('');
    }),
    Heartbeat: HeartbeatCtor,
    createHeartbeat: vi.fn(function (...args: any[]) {
      return new (HeartbeatCtor as any)(...args);
    }),
  };
});

vi.mock('../../src/foundation/cron/runner.js', () => {
  const CronRunner = vi.fn(function () {
    return mockCronRunner;
  });
  return {
    CronRunner,
    parseSchedule: vi.fn(function (s: string) {
      return s;
    }),
    // phase 1445 Step D: mirror 实然工厂契约 — createCronRunner 内自动 start(tickMs)
    createCronRunner: vi.fn(function (jobs: any, sink: any, tickMs?: number) {
      const r = new (CronRunner as any)(jobs, sink);
      r.start(tickMs);
      return r;
    }),
  };
});

vi.mock('../../src/core/memory/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/memory/index.js')>()),
  createMemorySystem: vi.fn(function () {
    return mockMemorySystem;
  }),
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
    createContractObserverJob: vi.fn(function (deps, globalConfig) {
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
  LLMOrchestratorImpl: vi.fn(function () {
    return { close: vi.fn(), healthCheck: vi.fn(), getProviderInfo: vi.fn() };
  }),
  createLLMOrchestrator: vi.fn(function () {
    return { close: vi.fn(), healthCheck: vi.fn(), getProviderInfo: vi.fn() };
  }),
}));

vi.mock('../../src/foundation/monitor/monitor.js', () => ({
  JsonlLogger: vi.fn(function () {
    return { log: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock('../../src/foundation/tools/registry.js', () => ({
  ToolRegistryImpl: vi.fn(function () {
    return {
      register: vi.fn(),
      getForProfile: vi.fn(function () {
        return [];
      }),
      getAll: vi.fn(function () {
        return [];
      }),
      formatForLLM: vi.fn(),
      unregister: vi.fn(),
    };
  }),
  createToolRegistry: vi.fn(function () {
    return {
      register: vi.fn(),
      getForProfile: vi.fn(function () {
        return [];
      }),
      getAll: vi.fn(function () {
        return [];
      }),
      formatForLLM: vi.fn(),
      unregister: vi.fn(),
    };
  }),
}));

vi.mock('../../src/foundation/tools/executor.js', () => ({
  ToolExecutorImpl: vi.fn(function () {
    return { execute: vi.fn() };
  }),
  createToolExecutor: vi.fn(function (...args: any[]) {
    return new (vi.fn(function () {
      return { execute: vi.fn() };
    }) as any)(...args);
  }),
}));

vi.mock('../../src/core/evolution-system/index.js', () => ({
  EvolutionSystem: vi.fn(function () {
    return {
      notifyContractCompleted: vi.fn().mockResolvedValue({ status: 'submitted' }),
      observeContractCompleted: vi.fn().mockResolvedValue({ status: 'submitted' }),
      init: vi.fn().mockResolvedValue(undefined),
    };
  }),
  createEvolutionSystem: vi.fn(function () {
    return {
      notifyContractCompleted: vi.fn().mockResolvedValue({ status: 'submitted' }),
      observeContractCompleted: vi.fn(async function (_ref: any, ctx: any) {
        // Simulate the real path where factory is called (evolution-system/system.ts)
        ctx.clawContractManagerFactory('/tmp/test-claw', 'test-claw', {} as any);
        return { status: 'submitted' };
      }),
      registerRetrospective: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
    };
  }),
  DISPATCH_SKILLS_PATH: 'clawspace/dispatch-skills',
  DISPATCH_SKILLS_SUBDIR: 'dispatch-skills',
  RETRO_AUDIT_EVENTS: { RETRO_TRIGGERED: 'retro_triggered' },
}));

vi.mock('../../src/core/contract/manager.js', () => {
  const ContractSystem = vi.fn(function () {
    const instance = {
      loadPaused: vi.fn(),
      resume: vi.fn(),
      onContractCompleted: vi.fn(function (cb: (contractId: string) => Promise<void>) {
        capturedContractCallback = cb;
        return () => {};
      }),
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      registerCreatePolicy: vi.fn(),
      createSubmitSubtaskTool: vi.fn(function () {
        return { name: 'submit_subtask', profiles: ['full'] };
      }),
      failActiveForExecutor: vi.fn().mockResolvedValue({ kind: 'committed' }),
    };
    capturedContractSystems.push(instance);
    return instance;
  });
  return {
    ContractSystem,
    // phase 1445 Step D: mirror 实然工厂契约 — bootReconcile=true 时工厂内 await init()
    createContractSystem: vi.fn(async function (deps: any) {
      const m = new (ContractSystem as any)(deps);
      if (deps.bootReconcile) await m.init();
      return m;
    }),
  };
});

vi.mock('../../src/core/async-task-system/system.js', () => {
  const AsyncTaskSystem = vi.fn(function () {
    const instance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      startDispatch: vi.fn(),
      shutdown: vi.fn(),
      addPostProcessor: vi.fn(),
      setMainDialogStore: vi.fn(),
      getInProcessRunningCount: vi.fn(function () {
        return 0;
      }),
    };
    capturedTaskSystems.push(instance);
    return instance;
  });
  return {
    AsyncTaskSystem,
    createAsyncTaskSystem: vi.fn(function (clawDir: any, fs: any, options: any) {
      return new (AsyncTaskSystem as any)(clawDir, fs, options);
    }),
  };
});

vi.mock('../../src/core/runtime/injector.js', () => ({
  ContextInjector: vi.fn(function () {
    return { buildSystemPrompt: vi.fn(), buildParts: vi.fn() };
  }),
  createContextInjector: vi.fn(function (...args: any[]) {
    return new (vi.fn(function () {
      return { buildSystemPrompt: vi.fn(), buildParts: vi.fn() };
    }) as any)(...args);
  }),
}));

vi.mock('../../src/foundation/tools/context.js', () => ({
  ExecContextImpl: vi.fn(function () {
    return { signal: undefined };
  }),
}));

vi.mock('../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/messaging/index.js')>();
  const MockInboxWriter = vi.fn().mockImplementation(function () {
    return {
      write: vi.fn().mockResolvedValue(undefined),
      writeSync: vi.fn(),
    };
  });
  (MockInboxWriter as any).readMeta = vi.fn();
  (MockInboxWriter as any).__internal_create = vi.fn(function () {
    return { write: vi.fn().mockResolvedValue(undefined), writeSync: vi.fn() };
  });
  return {
    ...actual,
    InboxReader: vi.fn(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        drainInbox: vi.fn(function () {
          return [];
        }),
        drainAndDeliver: vi.fn(function () {
          return { kind: 'complete', entries: [], handles: [] };
        }),
        markDone: vi.fn(),
        markFailed: vi.fn(),
        ack: vi.fn(),
        nack: vi.fn(),
      };
    }),
    OutboxWriter: vi.fn(function () {
      return { write: vi.fn().mockResolvedValue(undefined) };
    }),
    InboxWriter: MockInboxWriter,
    createInboxReader: vi.fn(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        drainInbox: vi.fn(function () {
          return [];
        }),
        drainAndDeliver: vi.fn(function () {
          return { kind: 'complete', entries: [], handles: [] };
        }),
        markDone: vi.fn(),
        markFailed: vi.fn(),
        ack: vi.fn(),
        nack: vi.fn(),
      };
    }),
    createOutboxWriter: vi.fn(function () {
      return { write: vi.fn().mockResolvedValue(undefined) };
    }),
    makeInboxPath: vi.fn(function (dir: string) {
      return dir;
    }),
    makeOutboxPath: vi.fn(function (_clawId: string, clawDir: string) {
      return clawDir + '/outbox/pending';
    }),
    readInboxFileMeta: vi.fn(),
    createInboxMessageTypeRegistry: vi.fn(function () {
      const map = new Map();
      return {
        register: vi.fn(function (declaration: { type: string; rendering: unknown }) {
          map.set(declaration.type, declaration.rendering);
        }),
        resolve: vi.fn(function (type: string) {
          return map.get(type);
        }),
      };
    }),
    // phase 1869 Step H: mock 保真——与真实 helper 同行为（逐条 register），
    // 使 registry.resolve 断言可穿到装配面（原先 no-op 使注册不可观测）。
    registerInboxMessageTypes: vi.fn(
      function (registry: { register: (d: { type: string; rendering: unknown }) => void }, declarations: readonly { type: string; rendering: unknown }[]) {
        for (const d of declarations) registry.register(d);
      },
    ),
  };
});

vi.mock('../../src/foundation/dialog-store/index.js', () => ({
  DialogStore: vi.fn(function () {
    return { load: vi.fn(), save: vi.fn(), archive: vi.fn(), systemPrompt: '' };
  }),
  createDialogStore: vi.fn(function () {
    return { load: vi.fn(), save: vi.fn(), archive: vi.fn(), restorePrefix: vi.fn() };
  }),
  DIALOG_DIR: 'dialog',
  DIALOG_ARCHIVE_DIR: 'dialog/archive',
  CURRENT_DIALOG_FILE: 'current.json',
}));

vi.mock('../../src/assembly/config/config-load.js', () => {
  // phase 1886 Step B: 兼容 alias buildLLMConfig 已删除，mock 归名单名；
  // mockImplementationOnce 语义不变。
  const llmConfigFn = vi.fn(function () {
    return { provider: 'mock' };
  });
  return { resolveLLMConfig: llmConfigFn };
});

vi.mock('../../src/core/contract/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/contract/index.js')>();
  return {
    ...mod,
    createContractSystem: vi.fn(function (...args: any[]) {
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
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

    // Phase 1396 Step M：retrospective 触发入口改为 ContractObserver bridge
    // （motion manager 的进程内 onContractCompleted 订阅已删除，避免双 producer）
    expect(capturedContractObserverDeps).toBeDefined();
    expect(capturedContractObserverDeps.onCompletedContract).toBeDefined();
    await capturedContractObserverDeps.onCompletedContract('motion', 'test-contract-id');

    // There should be at least 2 createContractSystem calls:
    // 1. main contract manager (line 233)
    // 2. factory call inside observeContractCompleted
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
  });

  it('handler returns early when memorySystem is undefined (non-motion claw)', async () => {
    (createMemorySystem as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

    const jobs = (CronRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dreamJob = jobs.find((j: any) => j.name === 'dream-trigger');
    expect(dreamJob).toBeDefined();

    // handler 应静默返回，不抛 NPE
    await expect(dreamJob.handler()).resolves.toBeUndefined();

    expect(mockMemorySystem.runDeepDream).not.toHaveBeenCalled();
    expect(mockMemorySystem.runRandomDream).not.toHaveBeenCalled();
  });

  it('handler invokes memorySystem methods when motion claw assembles', async () => {
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

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
describe('contract observer bridge → evolution guard (phase 620 / phase 1396 Step M)', () => {
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

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions })).resolves.toBeDefined();
  });

  it('observer bridge calls observeContractCompleted when evolutionSystem present (phase 1396 Step M)', async () => {
    const mockObserve = vi.fn().mockResolvedValue({ status: 'submitted' });
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      observeContractCompleted: mockObserve,
      notifyContractCompleted: vi.fn().mockResolvedValue({ status: 'submitted' }),
      registerRetrospective: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
    });

    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

    expect(capturedContractObserverDeps).toBeDefined();
    expect(capturedContractObserverDeps.onCompletedContract).toBeDefined();
    await capturedContractObserverDeps.onCompletedContract('claw-a', 'test-contract-id');

    expect(mockObserve).toHaveBeenCalledTimes(1);
    expect(mockObserve).toHaveBeenCalledWith(
      { contractId: 'test-contract-id', executorId: 'claw-a' },
      expect.anything(),
    );

    // Phase 1396 Step M: observer bridge 完成事实交付触发 retro_triggered audit
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'retro_triggered',
      'contractId=test-contract-id',
      'source=contract_observer',
      'status=submitted',
    );
  });

  it('rethrows the original error after audit when observeContractCompleted rejects', async () => {
    const mockObserve = vi.fn().mockRejectedValue(new Error('retro dispatch failed'));
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      observeContractCompleted: mockObserve,
      notifyContractCompleted: vi.fn().mockResolvedValue({ status: 'submitted' }),
      registerRetrospective: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
    });

    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

    expect(capturedContractObserverDeps).toBeDefined();
    expect(capturedContractObserverDeps.onCompletedContract).toBeDefined();
    await expect(capturedContractObserverDeps.onCompletedContract('claw-a', 'test-contract-id')).rejects.toThrow('retro dispatch failed');

    expect(mockObserve).toHaveBeenCalledTimes(1);
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'contract_completed_handler_failed',
      'contractId=test-contract-id',
      'source=contract_observer',
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

  function makeEvolutionSystemMock(overrides?: { observeContractCompleted?: any }) {
    return {
      observeContractCompleted: overrides?.observeContractCompleted ?? vi.fn().mockResolvedValue({ status: 'submitted' }),
      notifyContractCompleted: vi.fn().mockResolvedValue({ status: 'submitted' }),
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
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return makeEvolutionSystemMock();
    });
  });

  afterEach(() => {
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('non-motion assembly does not register retrospective post-processor', async () => {
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return undefined;
    });

    await assemble(clawBaseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

    const taskSystem = capturedTaskSystems.at(-1);
    expect(taskSystem).toBeDefined();
    const retroPostProcessorCalls = taskSystem.addPostProcessor.mock.calls.filter(
      (c: any[]) => c[0] === 'summon-contract-extract' || c[0] === 'dispatch-contract-extract',
    );
    expect(retroPostProcessorCalls.length).toBe(0);
  });

  it('contract observer bridge callback rethrows the original error', async () => {
    const mockObserve = vi.fn().mockRejectedValue(new Error('observer bridge failed'));
    (createEvolutionSystem as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return makeEvolutionSystemMock({ observeContractCompleted: mockObserve });
    });

    await assemble(motionBaseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

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


describe('phase1396-summon-claim-wiring', () => {
  /**
   * Phase 1396 Step B: Assembly wiring invariants.
   * - motion 装配的 summon post-processor 必须注入 claimStore + contractQuery
   *   （创建事实核实不再依赖 audit evidence 行）。
   * - summon-verify policy 必须带 claimStore（0/1 创建 claim）。
   */
  const ROOT = path.resolve(process.cwd());
  const businessSystemsSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'assembly', 'business-systems.ts'),
    'utf-8',
  );

  it('business-systems 为 summon post-processor 注入 claimStore + contractQuery', () => {
    const idx = businessSystemsSrc.indexOf('createSummonContractExtractPostProcessor(');
    expect(idx).toBeGreaterThanOrEqual(0);
    const call = businessSystemsSrc.slice(idx, idx + 500);
    expect(call).toContain('claimStore');
    expect(call).toContain('contractQuery');
  });

  it('business-systems 为 summon-verify policy 注入 claimStore', () => {
    const call = businessSystemsSrc.match(/createSummonVerifyPolicy\(\{[\s\S]*?\}\)/);
    expect(call).not.toBeNull();
    expect(call![0]).toContain('claimStore');
  });
});


describe('phase1901-contract-action-policy-assembly', () => {
  /**
   * Phase 1901 Step B: policy authority 与 support capability 分离装配。
   * - 新增 policy-only 选项 registerSummonVerifyPolicy（--file / start 路径）；
   * - policy 注册条件 = withSummonVerifyPolicy || registerSummonVerifyPolicy；
   * - support tools（fileTools/topology/crossTargetAccess）仍仅由 withSummonVerifyPolicy
   *   授予（--dir 保留，file/start 不扩大 capability）。
   */
  const ROOT = path.resolve(process.cwd());
  const actionSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'assembly', 'contract-action.ts'),
    'utf-8',
  );

  it('contract-action.ts 提供 policy-only 选项且 policy 注册条件覆盖两选项', () => {
    expect(actionSrc).toContain('registerSummonVerifyPolicy?: boolean');
    expect(actionSrc).toMatch(
      /opts\.withSummonVerifyPolicy \|\| opts\.registerSummonVerifyPolicy/,
    );
    // policy 注册在任一选项下生效
    expect(actionSrc).toMatch(/if \(summonPolicy\) \{\s*system\.registerCreatePolicy\('summon-verify', summonPolicy\)/);
  });

  it('support tools/topology 仍仅由 withSummonVerifyPolicy 授予（--dir 不退化、file/start 不扩大）', () => {
    const toolsBlock = actionSrc.match(/if \(opts\.withSummonVerifyPolicy\) \{[\s\S]*?\n  \}/);
    expect(toolsBlock).not.toBeNull();
    expect(toolsBlock![0]).toContain('createFileTools');
    expect(toolsBlock![0]).toContain('wireClawTopology');
    expect(toolsBlock![0]).toContain('createCrossTargetAccess');
    // policy 构造不绑定 support tools：createSummonVerifyPolicy 出现在该块之外
    expect(toolsBlock![0]).not.toContain('createSummonVerifyPolicy');
  });
});


describe('phase1396-execution-recovery-wiring', () => {
  /**
   * Phase 1396 Step E: Assembly 为 EventLoop 注入执行停滞恢复依赖。
   * Phase 1840: 提醒链失败出口退役——instances.executionRecovery 不再携带
   * failureSink，装配不调用 ContractSystem.failActiveForExecutor（该入口保留给
   * 其他真实失败源）。
   * - instances.executionRecovery 存在（daemon → EventLoop options）。
   */
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
    capturedContractSystems.length = 0;
    capturedRuntimeDeps.length = 0;
  });

  it('assemble 输出 executionRecovery：无 failureSink 属性，failActiveForExecutor 未被提醒装配调用', async () => {
    const instances = await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

    expect(instances.executionRecovery).toBeDefined();
    expect(instances.executionRecovery).not.toHaveProperty('failureSink');
    const contractManager = capturedContractSystems[0];
    expect(contractManager).toBeDefined();
    expect(contractManager.failActiveForExecutor).not.toHaveBeenCalled();
  });

  it('probeActivity / isAsyncTaskInFlight 已接线（mock fs 无 active contract → undefined）', async () => {
    const instances = await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });

    const probe = await instances.executionRecovery!.probeActivity();
    expect(probe.activeContractId).toBeUndefined();
    await expect(instances.executionRecovery!.isAsyncTaskInFlight!()).resolves.toBe(false);
  });

  it('phase 1869 Step G: contractTerminalFact capability 已注入（消费适用性判定接线）', async () => {
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });
    const deps = capturedRuntimeDeps.at(-1);
    expect(deps).toBeDefined();
    expect(typeof deps.contractTerminalFact).toBe('function');
  });

  it('phase 1869 Step H: execution_recovery rendering 已装配（真实 registry resolve 命中）', async () => {
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory, createSkillVersions: mockCreateSkillVersions });
    const deps = capturedRuntimeDeps.at(-1);
    expect(deps.formatterRegistry.resolve('execution_recovery')).toEqual({
      kind: 'standard',
      presentation: 'system',
    });
  });
});
