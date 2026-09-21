import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assemble } from '../../src/assembly/assemble.js';
import { cleanupOrphanedTemp } from '../../src/assembly/cleanup.js';
import { buildTestGlobalConfig } from '../helpers/global-config.js';

// ============================================================================
// Shared mock instances (captured by vi.mock factories)
// ============================================================================
const mockAuditWrite = vi.fn();
const mockAuditDispose = vi.fn();
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
// phase 1791: mock 补显式恢复点（装配期 initialize() 恢复 due 基线；缺省 absent=首次启动）
const mockHeartbeat = { initialize: vi.fn(async () => ({ kind: 'absent' as const })) };

// phase 1260 Step B: capture ContractSystem instances for direct-attach assertions
// phase 1872 Step F: 捕获 ctor deps（sink/auditor 构造参数一次固定后，装配面断言看 deps）
const capturedContractManagers: Array<{ instance: Record<string, unknown>; deps: Record<string, unknown> }> = [];
// phase 1872 Step C: rollback teardown 断言面（llm close / task shutdown 实例捕获）
const capturedLlmInstances: Array<{ close: ReturnType<typeof vi.fn> }> = [];
const capturedTaskSystems: Array<{ shutdown: ReturnType<typeof vi.fn> }> = [];
/** phase 1872 Step C: 次生失败注入（下一次 llm.close 拒绝）。 */
let failNextLlmClose = false;
/** phase 1872 Step F: 交付时点 tool registry 快照（createRuntime 调用瞬间的工具名）。 */
let toolNamesAtRuntimeConstruction: string[] = [];
/** phase 1872 Step F: 交付给 Runtime 的 registry 实例（装配期内继续注册 shadowTool 的同一对象）。 */
let runtimeToolRegistry: { getAll(): Array<{ name: string }> } | undefined;

// ============================================================================
// Construction order tracking (phase155C)
// ============================================================================
const callOrder: string[] = [];

// phase 121: DI-injected mock factory for createSkillSystem (replaces vi.mock)
const { mockSkillFactory } = vi.hoisted(() => ({
  mockSkillFactory: vi.fn((..._args: any[]) => {
    callOrder.push('SkillSystem');
    return {
      loadAll: vi.fn().mockResolvedValue(undefined),
      ensureLoaded: vi.fn().mockResolvedValue(undefined),
      getSkills: vi.fn(() => []),
    };
  }),
}));

function trackCtor(name: string, factory: () => any) {
  return vi.fn((...args: any[]) => {
    callOrder.push(name);
    return factory(...args);
  });
}

// ============================================================================
// Module mocks
// ============================================================================
vi.mock('../../src/foundation/audit/writer.js', () => ({
  AuditWriter: vi.fn(() => ({
    write: mockAuditWrite,
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
    // phase 1872 Step C: rollback teardown 断言面（AuditLog.dispose? 可选方法）。
    dispose: mockAuditDispose,
  })),
  AUDIT_FILE: 'audit.tsv',
  TICK_RETENTION_DAYS: 30,
  reconcileFallbackDumps: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/foundation/snapshot/index.js', () => ({
  Snapshot: vi.fn(() => mockSnapshot),
  createSnapshot: vi.fn(() => mockSnapshot),
  SNAPSHOT_FILE_ROUTING: {},
}));

// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 迁出 foundation/snapshot、归 assembly/snapshot-patterns。
// mock 直接覆盖 aggregator 文件、避免触发 stream/audit/async-task 各 owner *_SNAPSHOT_IGNORE 的解析链。
vi.mock('../../src/assembly/config/snapshot-patterns.js', () => ({
  SNAPSHOT_IGNORE_PATTERNS: ['.git', 'node_modules'],
}));

vi.mock('../../src/foundation/stream/writer.js', () => ({
  StreamWriter: vi.fn(() => mockStreamWriter),
  createStreamWriter: vi.fn(() => mockStreamWriter),
}));

vi.mock('../../src/foundation/stream/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/foundation/stream/index.js')>();
  return {
    ...mod,
    createStreamWriter: vi.fn(() => mockStreamWriter),
    STREAM_FILE_ROUTING: {},
  };
});

vi.mock('../../src/foundation/fs/node-fs.js', () => ({
  NodeFileSystem: vi.fn(({ baseDir }: { baseDir: string }) => ({
    ensureDir: vi.fn().mockResolvedValue(undefined),
    ensureDirSync: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    existsSync: vi.fn((p: string) => fs.existsSync(path.join(baseDir, p))),
    statSync: vi.fn((p: string) => fs.statSync(path.join(baseDir, p))),
    readBytesSync: vi.fn((p: string, start: number, end: number) => {
      const buf = fs.readFileSync(path.join(baseDir, p));
      return buf.subarray(start, end);
    }),
    listSync: vi.fn(() => []),
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockRejectedValue(new Error('ENOENT')),
    // Phase 1826: LLM 恢复状态读写（owner session 构造期读状态文件；默认 ENOENT = 首次启动）。
    readSync: vi.fn((p: string) => {
      const full = path.join(baseDir, p);
      if (!fs.existsSync(full)) {
        const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return fs.readFileSync(full, 'utf-8');
    }),
    writeAtomicSync: vi.fn((p: string, content: string) => {
      const full = path.join(baseDir, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }),
    deleteSync: vi.fn((p: string) => {
      const full = path.join(baseDir, p);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    // phase 1818: createClawPermissionChecker 构造期必需 canonical resolve capability，
    // mock 亦须提供（词法 join 即可——本文件断言与 containment 无关）
    resolve: vi.fn((p: string) => (path.isAbsolute(p) ? p : path.join(baseDir, p))),
    // phase 1817: GuardedWrite 消费 realpath/writeAtomic/append——构造期校验一并要求
    realpath: vi.fn(async (p: string) => (path.isAbsolute(p) ? p : path.join(baseDir, p))),
    append: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/assembly/cleanup.js', () => ({
  cleanupOrphanedTemp: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/foundation/process-manager/agent-factory.js', () => ({
  createAgentProcessManager: vi.fn(() => mockProcessManager),
}));

vi.mock('../../src/core/runtime/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/runtime/index.js')>()),
  Runtime: vi.fn(() => mockRuntime),
  createRuntime: vi.fn((opts: { dependencies?: { toolRegistry?: { getAll(): Array<{ name: string }> } } }) => {
    callOrder.push('Runtime');
    // phase 1872 Step F: 记录交付瞬间的工具面（注册必须在运行时使用前完成）
    toolNamesAtRuntimeConstruction = opts?.dependencies?.toolRegistry?.getAll().map(t => t.name) ?? [];
    runtimeToolRegistry = opts?.dependencies?.toolRegistry;
    return mockRuntime;
  }),
  buildMotionSystemPrompt: vi.fn(() => Promise.resolve('')),
}));

vi.mock('../../src/core/heartbeat/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/heartbeat/index.js')>();
  const HeartbeatCtor = vi.fn(() => mockHeartbeat);
  return {
    ...actual,
    Heartbeat: HeartbeatCtor,
    createHeartbeat: vi.fn((...args: any[]) => new (HeartbeatCtor as any)(...args)),
  };
});

vi.mock('../../src/foundation/cron/runner.js', () => {
  const CronRunner = vi.fn(() => mockCronRunner);
  return {
    CronRunner,
    parseSchedule: vi.fn((s: string) => s),
    // phase 1445 Step D: mirror 实然工厂契约 — createCronRunner 内自动 start(tickMs)
    createCronRunner: vi.fn((jobs: any, sink: any, tickMs?: number) => {
      const r = new (CronRunner as any)(jobs, sink);
      r.start(tickMs);
      return r;
    }),
  };
});

const mockMemorySystem = {
  runDeepDream: vi.fn(),
  runRandomDream: vi.fn(),
};

vi.mock('../../src/core/memory/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/memory/index.js')>()),
  createMemorySystem: vi.fn(() => mockMemorySystem),
  memorySearchTool: { name: 'memory_search' },
  MEMORY_DIR: 'memory',
  MEMORY_FILE_ROUTING: {},
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

vi.mock('../../src/foundation/llm-orchestrator/orchestrator.js', () => {
  const LLMOrchestratorImpl = trackCtor('LLMOrchestratorImpl', () => {
    const instance = {
      close: vi.fn(() => (failNextLlmClose ? Promise.reject(new Error('llm close boom')) : Promise.resolve())),
      healthCheck: vi.fn(),
      getProviderInfo: vi.fn(),
    };
    capturedLlmInstances.push(instance);  // phase 1872 Step C: rollback teardown 断言面
    return instance;
  });
  return {
    LLMOrchestratorImpl,
    createLLMOrchestrator: vi.fn((config: any) => new (LLMOrchestratorImpl as any)(config)),
  };
});

vi.mock('../../src/foundation/monitor/monitor.js', () => ({
  JsonlLogger: trackCtor('JsonlLogger', () => ({ log: vi.fn(), close: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/registry.js', () => {
  // phase 1872 Step F: mock 保真——register 记账、getAll 反映注册面
  // （ToolRegistry 冻结面断言可穿到装配序）。
  const ToolRegistryImpl = trackCtor('ToolRegistryImpl', () => {
    const tools: Array<{ name: string }> = [];
    return {
      register: vi.fn((t: { name: string }) => { tools.push(t); }),
      getForProfile: vi.fn(() => []),
      getAll: vi.fn(() => tools),
      formatForLLM: vi.fn(),
      unregister: vi.fn(),
    };
  });
  return {
    ToolRegistryImpl,
    createToolRegistry: vi.fn(() => new (ToolRegistryImpl as any)()),
  };
});

vi.mock('../../src/foundation/tools/executor.js', () => {
  const Ctor = trackCtor('ToolExecutorImpl', () => ({ execute: vi.fn() }));
  return {
    ToolExecutorImpl: Ctor,
    createToolExecutor: vi.fn((...args: any[]) => new (Ctor as any)(...args)),
  };
});

vi.mock('../../src/core/contract/manager.js', () => {
  const ContractSystem = trackCtor('ContractSystem', (deps: Record<string, unknown>) => {
    const instance = { loadPaused: vi.fn(), resume: vi.fn(), onContractCompleted: vi.fn(() => () => {}), init: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), registerCreatePolicy: vi.fn(), createSubmitSubtaskTool: vi.fn(() => ({ name: 'submit_subtask', profiles: ['full'] })) };
    capturedContractManagers.push({ instance, deps });
    return instance;
  });
  return {
    ContractSystem,
    // phase 1445 Step D: mirror 实然工厂契约 — bootReconcile=true 时工厂内 await init()
    createContractSystem: vi.fn(async (deps: any) => {
      const m = new (ContractSystem as any)(deps);
      if (deps.bootReconcile) await m.init();
      return m;
    }),
  };
});

vi.mock('../../src/core/async-task-system/system.js', () => {
  const AsyncTaskSystem = trackCtor('AsyncTaskSystem', () => {
    const instance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      startDispatch: vi.fn(),
      shutdown: vi.fn(),
      addPostProcessor: vi.fn(),
      setMainDialogStore: vi.fn(),
      // phase 1872 Step F: mock 保真——真实 ATS 提供 async exec 包装（装配面据此注册 exec）
      createAsyncExecWrapper: vi.fn(() => ({ name: 'exec', profiles: ['full'] })),
    };
    capturedTaskSystems.push(instance);  // phase 1872 Step C: rollback teardown 断言面
    return instance;
  });
  return {
    AsyncTaskSystem,
    createAsyncTaskSystem: vi.fn((clawDir: any, fs: any, options: any) => new (AsyncTaskSystem as any)(clawDir, fs, options)),
  };
});

vi.mock('../../src/core/runtime/injector.js', () => {
  const Ctor = trackCtor('ContextInjector', () => ({ buildSystemPrompt: vi.fn(), buildParts: vi.fn() }));
  return {
    ContextInjector: Ctor,
    createContextInjector: vi.fn((...args: any[]) => new (Ctor as any)(...args)),
  };
});

vi.mock('../../src/foundation/tools/context.js', () => ({
  ExecContextImpl: trackCtor('ExecContextImpl', () => ({ signal: undefined })),
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
    InboxReader: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined), drainInbox: vi.fn(() => []), drainAndDeliver: vi.fn(() => ({ kind: 'complete', entries: [], handles: [] })), markDone: vi.fn(), markFailed: vi.fn(), ack: vi.fn(), nack: vi.fn() })),
    OutboxWriter: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
    InboxWriter: MockInboxWriter,
    createInboxReader: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined), drainInbox: vi.fn(() => []), drainAndDeliver: vi.fn(() => ({ kind: 'complete', entries: [], handles: [] })), markDone: vi.fn(), markFailed: vi.fn(), ack: vi.fn(), nack: vi.fn() })),
    createOutboxWriter: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
    makeInboxPath: vi.fn((dir: string) => dir),
    makeOutboxPath: vi.fn((_clawId: string, clawDir: string) => clawDir + '/outbox/pending'),
    readInboxFileMeta: vi.fn(),
    // phase 1243: formatter registry + Messaging 自家 declarations mock
    createInboxMessageTypeRegistry: vi.fn(() => {
      const map = new Map<string, unknown>();
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
  // phase 1886 Step B: 兼容 alias buildLLMConfig 已删除，mock 归名单名；
  // mockImplementationOnce 语义不变。
  const llmConfigFn = vi.fn(() => ({ provider: 'mock' }));
  return { resolveLLMConfig: llmConfigFn };
});

// phase 265: hoist 14 dynamic imports below. vitest hoists all vi.mock(...) above
// to the top of the file, so these static imports resolve to the mocked
// modules (or real ones if not mocked) just as the per-test `await import`
// did, without paying the per-invocation resolution cost.
import { createStreamWriter } from '../../src/foundation/stream/index.js';
import { CronRunner } from '../../src/foundation/cron/runner.js';
import { resolveLLMConfig } from '../../src/assembly/config/config-load.js';
import { createAgentProcessManager } from '../../src/foundation/process-manager/agent-factory.js';
import { createSnapshot } from '../../src/foundation/snapshot/index.js';
import { createRuntime } from '../../src/core/runtime/index.js';
import { Heartbeat } from '../../src/core/heartbeat/index.js';
import { createMemorySystem } from '../../src/core/memory/index.js';
import { runContractObserver } from '../../src/core/contract/jobs/contract-observer.js';
import { createContractSystem } from '../../src/core/contract/manager.js';
// phase 1872 Step G: 首载失败分类断言（owner 类型化错误）
import { SkillSystemInitialLoadError } from '../../src/foundation/skill-system/index.js';


// ============================================================================
// Tests
// ============================================================================
describe('assemble', () => {
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
    callOrder.length = 0;
    toolNamesAtRuntimeConstruction = [];
    runtimeToolRegistry = undefined;
    capturedContractManagers.length = 0;
    capturedLlmInstances.length = 0;
    capturedTaskSystems.length = 0;
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
  });

  // --------------------------------------------------------------------------
  // 分支穷尽
  // --------------------------------------------------------------------------
  it('motion + cron.enabled + heartbeat>0 → 只公开 heartbeat，私有资源由 session dispose', async () => {
    const result = await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    expect(result.heartbeat).toBe(mockHeartbeat);
    expect(result).not.toHaveProperty('cronRunner');
    expect(result).not.toHaveProperty('gateway');
    expect(result).not.toHaveProperty('clawId');
    expect(mockCronRunner.start).toHaveBeenCalled();
    await result.dispose('SIGTERM');
    expect(mockCronRunner.stop).toHaveBeenCalled();
    expect(mockRuntime.stop).toHaveBeenCalled();
    expect(mockStreamWriter.close).toHaveBeenCalled();
  });

  it('motion + cron.enabled=false → 不构造 cronRunner、仍公开 heartbeat', async () => {
    const config = {
      ...baseConfig,
      globalConfig: {
        ...baseConfig.globalConfig,
        cron: { ...baseConfig.globalConfig.cron, enabled: false },
      },
    };
    const result = await assemble(config, undefined, { createSkillSystem: mockSkillFactory });

    expect(result).not.toHaveProperty('cronRunner');
    expect(result.heartbeat).toBe(mockHeartbeat);
    expect(mockCronRunner.start).not.toHaveBeenCalled();
  });

  it('motion + heartbeat_interval_ms=0 → 无 heartbeat', async () => {
    const config = {
      ...baseConfig,
      globalConfig: {
        ...baseConfig.globalConfig,
        motion: { ...baseConfig.globalConfig.motion, heartbeat_interval_ms: 0 },
      },
    };
    const result = await assemble(config, undefined, { createSkillSystem: mockSkillFactory });

    expect(result.heartbeat).toBeUndefined();
    expect(result).not.toHaveProperty('cronRunner');
    expect(mockCronRunner.start).toHaveBeenCalled();
  });

  it('claw identity → 无 motion extension，返回稳定 session shape', async () => {
    const config = {
      ...baseConfig,
      identity: 'claw' as const,
      clawId: 'test-claw',
      clawConfig: {
        max_steps: 10,
        tool_profile: 'full',
        subagent_max_steps: 5,
        max_concurrent_tasks: 3,
      },
    };
    const result = await assemble(config, undefined, { createSkillSystem: mockSkillFactory });

    expect(result.heartbeat).toBeUndefined();
    expect(result).not.toHaveProperty('cronRunner');
    expect(result).not.toHaveProperty('gateway');
    expect(result).not.toHaveProperty('clawId');
    expect(result.dispose).toEqual(expect.any(Function));
  });

  // --------------------------------------------------------------------------
  // audit 事件
  // --------------------------------------------------------------------------
  it('成功路径末尾写 daemon_started', async () => {
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    expect(mockAuditWrite).toHaveBeenCalledWith(
      'daemon_started',
      expect.stringContaining('clawId=motion'),
      expect.stringContaining('pid=')
    );
  });

  it('启动清理在 writer 激活前 await 执行并传入 startTime', async () => {
    const before = Date.now();
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });
    const after = Date.now();

    expect(cleanupOrphanedTemp).toHaveBeenCalledTimes(1);
    expect(cleanupOrphanedTemp).toHaveBeenCalledWith(
      expect.anything(),
      baseConfig.clawDir,
      expect.any(Number),
    );
    const startTime = (cleanupOrphanedTemp as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as number;
    expect(startTime).toBeGreaterThanOrEqual(before);
    expect(startTime).toBeLessThanOrEqual(after);
  });

  // --------------------------------------------------------------------------
  // 失败语义
  // --------------------------------------------------------------------------
  it('snapshot.init 失败 → assemble_failed + 抛 Error（phase 1445 Step D：init 内化进工厂、失败由工厂抛）', async () => {
    (createSnapshot as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Snapshot.init failed: git_error')
    );

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: Snapshot construct failed: Snapshot.init failed: git_error'
    );

    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=snapshot',
      'phase=construct',
      'reason=Snapshot.init failed: git_error'
    );
  });

  it('snapshot.commit recovery 失败 → assemble_failed + 不抛', async () => {
    mockSnapshot.commit.mockResolvedValue({
      ok: false,
      error: { kind: 'commit_error' },
    });

    const result = await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    expect(result).toBeDefined();
    expect(result.snapshot).toBe(mockSnapshot);
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=snapshot',
      'phase=recovery-commit',
      'reason=commit_error'
    );
  });

  it('StreamWriter 构造失败 → assemble_failed + 抛 Error', async () => {
    (createStreamWriter as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('stream fail');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: StreamWriter construct failed: stream fail'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=stream_writer',
      'phase=construct',
      'reason=stream fail'
    );
  });

  it('CronRunner 构造失败 → assemble_failed + 抛 Error', async () => {
    (CronRunner as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('cron fail');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: CronRunner construct failed: cron fail'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=cron_runner',
      'phase=construct',
      'reason=cron fail'
    );
  });

  // --------------------------------------------------------------------------
  // phase 1872 Step C: 构造回滚（反序 teardown + 次生失败留证）
  // --------------------------------------------------------------------------
  describe('构造回滚（phase 1872 Step C）', () => {
    it('core 内部失败（contract 构造失败）→ 已构造子资源反序自清（llm → streamWriter → audit）', async () => {
      (createContractSystem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('contract boom')
      );

      await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
        'Assembly: ContractSystem construct failed: contract boom'
      );

      const llm = capturedLlmInstances.at(-1)!;
      expect(llm.close).toHaveBeenCalledTimes(1);
      expect(mockStreamWriter.close).toHaveBeenCalledTimes(1);
      expect(mockAuditDispose).toHaveBeenCalled();
      // 反序：llm（后构造）先释放、audit（先构造）最后释放
      expect(llm.close.mock.invocationCallOrder[0])
        .toBeLessThan(mockStreamWriter.close.mock.invocationCallOrder[0]);
      expect(mockStreamWriter.close.mock.invocationCallOrder[0])
        .toBeLessThan(mockAuditDispose.mock.invocationCallOrder[0]);
    });

    it('runtime 阶段失败（snapshot 构造失败）→ assemble 级反序 teardown（task → contract → llm → streamWriter → audit）', async () => {
      (createSnapshot as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('snap boom'));

      await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
        'Assembly: Snapshot construct failed: snap boom'
      );

      const contract = capturedContractManagers.at(-1)!.instance as { close: ReturnType<typeof vi.fn> };
      const task = capturedTaskSystems.at(-1)!;
      const llm = capturedLlmInstances.at(-1)!;
      expect(task.shutdown).toHaveBeenCalledTimes(1);
      expect(contract.close).toHaveBeenCalledTimes(1);
      expect(llm.close).toHaveBeenCalledTimes(1);
      expect(mockStreamWriter.close).toHaveBeenCalledTimes(1);
      expect(mockAuditDispose).toHaveBeenCalled();
      const order = [
        task.shutdown.mock.invocationCallOrder[0],
        contract.close.mock.invocationCallOrder[0],
        llm.close.mock.invocationCallOrder[0],
        mockStreamWriter.close.mock.invocationCallOrder[0],
        mockAuditDispose.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('motion 阶段失败（CronRunner 构造失败）→ runtime/core 资源同样反序 teardown', async () => {
      (CronRunner as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('cron boom');
      });

      await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
        'Assembly: CronRunner construct failed: cron boom'
      );

      const task = capturedTaskSystems.at(-1)!;
      expect(mockRuntime.stop).toHaveBeenCalledTimes(1);
      expect(task.shutdown).toHaveBeenCalledTimes(1);
      expect(mockAuditDispose).toHaveBeenCalled();
      // 反序：runtime（后构造）先于 task_system
      expect(mockRuntime.stop.mock.invocationCallOrder[0])
        .toBeLessThan(task.shutdown.mock.invocationCallOrder[0]);
    });

    it('次生失败留证：llm.close 回滚失败 → assemble_failed module=rollback step=llm（无空 catch）、原 error 不丢', async () => {
      failNextLlmClose = true;
      (createSnapshot as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('snap boom'));
      try {
        await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
          'Assembly: Snapshot construct failed: snap boom'  // 原 error 未被次生失败遮蔽
        );
      } finally {
        failNextLlmClose = false;
      }

      expect(mockAuditWrite).toHaveBeenCalledWith(
        'assemble_failed',
        'module=rollback',
        'step=llm',
        'reason=llm close boom'
      );
      // 次生失败不中断反序链：其余 teardown 照常执行
      expect(mockStreamWriter.close).toHaveBeenCalledTimes(1);
      expect(mockAuditDispose).toHaveBeenCalled();
    });

    it('phase 1872 Step F: ToolRegistry 注册在装配期完成（运行时使用前冻结面）', async () => {
      await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

      // createRuntime 交付瞬间：base 注册 + async exec wrapper 已就位（exec 名不变）
      expect(toolNamesAtRuntimeConstruction).toContain('exec');
      // assemble 返回前：shadowTool 完成注册（post-runtime 但 pre-return——交付 daemon
      // 使用（initialize/turn）前注册面已完整；交付后无任何 register 调用点）。
      expect(runtimeToolRegistry).toBeDefined();
      expect(runtimeToolRegistry!.getAll().map(t => t.name)).toContain('shadow');
    });

    it('成功路径零漂移：装配成功不触发任何 rollback teardown', async () => {
      const result = await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

      expect(result).toBeDefined();
      expect(mockAuditDispose).not.toHaveBeenCalled();
      expect(mockStreamWriter.close).not.toHaveBeenCalled();
      expect(capturedLlmInstances.at(-1)!.close).not.toHaveBeenCalled();
      expect(capturedTaskSystems.at(-1)!.shutdown).not.toHaveBeenCalled();
      expect(mockRuntime.stop).not.toHaveBeenCalled();
    });
  });

  it('CronRunner.start 失败时 stream.daemon_started 未调用', async () => {
    mockCronRunner.start.mockImplementationOnce(() => {
      throw new Error('start boom');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow();
    expect(mockStreamWriter.write).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'daemon_started' }),
    );
  });

  it('CronRunner.start 失败 → assemble_failed + 抛 Error（phase 1445 Step D：start 内化进工厂、并入 construct catch）', async () => {
    mockCronRunner.start.mockImplementationOnce(() => {
      throw new Error('start boom');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: CronRunner construct failed: start boom'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=cron_runner',
      'phase=construct',
      'reason=start boom'
    );
  });

  it('resolveLLMConfig 失败 → assemble_failed module=llm_config + 抛 Error', async () => {
    (resolveLLMConfig as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('llm cfg boom');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: resolveLLMConfig failed: llm cfg boom'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=llm_config',
      'phase=construct',
      'reason=llm cfg boom'
    );
  });

  it('phase 1260 Step B: Assembly 直接 attach notification sink 到 contractManager（先 attach 后 createRuntime）', async () => {
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

    // 原 daemon_started 构造期路径覆盖保留
    expect(mockStreamWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: expect.any(Number),
        type: 'daemon_started',
      })
    );

    // phase 1872 Step F: sink 经构造参数一次固定（setOnNotify setter 退役）——
    // 装配面断言改看 createContractSystem 收到的 deps；构造即 attach（先于 createRuntime）。
    expect(capturedContractManagers.length).toBeGreaterThan(0);
    const { deps } = capturedContractManagers[0];
    const sink = deps.onNotify as unknown;
    expect(typeof sink).toBe('function');

    // construct 必须先于 createRuntime（构造即 attach，无短窗口漏 event）
    expect(callOrder).toContain('ContractSystem');
    expect(callOrder.indexOf('ContractSystem')).toBeLessThan(callOrder.indexOf('Runtime'));

    // transport 行为：typed event → stream system_notify legacy shape（详细逐字段 shape 见
    // tests/assembly/contract-notification-adapter.test.ts）
    (sink as (event: unknown) => void)({
      type: 'contract_cancelled',
      contractId: 'c1',
      reason: 'user cancelled',
    });
    expect(mockStreamWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: expect.any(Number),
        type: 'system_notify',
        subtype: 'contract_cancelled',
        contractId: 'c1',
        reason: 'user cancelled',
      })
    );
  });

  it('ProcessManager 构造失败 → assemble_failed + 抛 Error', async () => {
    (createAgentProcessManager as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('pm fail');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: ProcessManager construct failed: pm fail'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=process_manager',
      'phase=construct',
      'reason=pm fail'
    );
  });

  it('Snapshot 构造失败 → assemble_failed + 抛 Error', async () => {
    (createSnapshot as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('snapshot fail');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: Snapshot construct failed: snapshot fail'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=snapshot',
      'phase=construct',
      'reason=snapshot fail'
    );
  });

  it('Runtime 构造失败 → assemble_failed + 抛 Error', async () => {
    (createRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('runtime fail');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: Runtime construct failed: runtime fail'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=runtime',
      'phase=construct',
      'reason=runtime fail'
    );
  });

  it('Heartbeat 构造失败 → assemble_failed + 抛 Error', async () => {
    (Heartbeat as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('heartbeat fail');
    });

    await expect(assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory })).rejects.toThrow(
      'Assembly: Heartbeat construct failed: heartbeat fail'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=heartbeat',
      'phase=construct',
      'reason=heartbeat fail'
    );
  });

  it('所有 CronRunner job handlers 应正确引用对应的 cron jobs', async () => {
    await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });
    const jobs = (CronRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

    for (const job of jobs) {
      if (typeof job.handler === 'function') {
        await job.handler();
      }
    }


    expect(createMemorySystem).toHaveBeenCalled();
    expect(mockMemorySystem.runDeepDream).toHaveBeenCalled();
    expect(mockMemorySystem.runRandomDream).toHaveBeenCalled();
    expect(runContractObserver).toHaveBeenCalled();
  });

  // ==========================================================================
  // detectUncleanExit (assemble.ts L20-56)
  // ==========================================================================
  describe('detectUncleanExit', () => {
    let tmpDir: string;
    let configWithTmp: typeof baseConfig;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-unclean-'));
      configWithTmp = { ...baseConfig, clawDir: tmpDir };
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('上次正常关停（末条 daemon_stop）→ 不写 daemon_unclean_exit', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'audit.tsv'),
        '2026-04-19T10:00:00.000Z\tdaemon_started\tclawId=motion\n' +
        '2026-04-19T11:00:00.000Z\tdaemon_stop\tsignal=sigterm\n',
      );

      await assemble(configWithTmp, undefined, { createSkillSystem: mockSkillFactory });

      expect(mockAuditWrite).not.toHaveBeenCalledWith(
        'daemon_unclean_exit',
        expect.any(String),
      );
    });

    it('上次崩溃（末条 daemon_crash）→ 不重复写 daemon_unclean_exit', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'audit.tsv'),
        '2026-04-19T10:00:00.000Z\tdaemon_started\tclawId=motion\n' +
        '2026-04-19T11:00:00.000Z\tdaemon_crash\terr=boom\n',
      );

      await assemble(configWithTmp, undefined, { createSkillSystem: mockSkillFactory });

      expect(mockAuditWrite).not.toHaveBeenCalledWith(
        'daemon_unclean_exit',
        expect.any(String),
      );
    });

    it('上次已记录 unclean_exit（末条 daemon_unclean_exit）→ 不重复写', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'audit.tsv'),
        '2026-04-19T10:00:00.000Z\tdaemon_started\tclawId=motion\n' +
        '2026-04-19T11:00:00.000Z\tdaemon_unclean_exit\tlast_ts=2026-04-19T10:00:00.000Z\n',
      );

      await assemble(configWithTmp, undefined, { createSkillSystem: mockSkillFactory });

      expect(mockAuditWrite).not.toHaveBeenCalledWith(
        'daemon_unclean_exit',
        expect.any(String),
      );
    });

    it('上次未正常关停（末条非 stop/crash/unclean）→ 写 daemon_unclean_exit 含 last_ts', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'audit.tsv'),
        '2026-04-19T10:00:00.000Z\tdaemon_started\tclawId=motion\n' +
        '2026-04-19T11:00:00.000Z\tcontract_notify\ttype=review_request\n',
      );

      await assemble(configWithTmp, undefined, { createSkillSystem: mockSkillFactory });

      expect(mockAuditWrite).toHaveBeenCalledWith(
        'daemon_unclean_exit',
        'last_ts=2026-04-19T11:00:00.000Z',
      );
    });

    it('audit.tsv 不存在 → 静默跳过', async () => {
      await assemble(configWithTmp, undefined, { createSkillSystem: mockSkillFactory });

      expect(mockAuditWrite).not.toHaveBeenCalledWith(
        'daemon_unclean_exit',
        expect.any(String),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Assembly construction order (phase155C)
  // --------------------------------------------------------------------------
  describe('Assembly construction order (phase155C)', () => {
    it('constructs L3-L5 modules in dependency-safe order', async () => {
      await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });

      const required = [
        'LLMOrchestratorImpl', 'ToolRegistryImpl',
        'SkillSystem', 'ContractSystem',
        'AsyncTaskSystem', 'ToolExecutorImpl',
      ];
      for (const name of required) {
        expect(callOrder, `missing ${name}`).toContain(name);
      }

      const idx = (name: string) => callOrder.indexOf(name);
      expect(idx('LLMOrchestratorImpl')).toBeLessThan(idx('AsyncTaskSystem'));
      expect(idx('SkillSystem')).toBeLessThan(idx('AsyncTaskSystem'));
      expect(idx('ContractSystem')).toBeLessThan(idx('AsyncTaskSystem'));
      expect(idx('ToolRegistryImpl')).toBeLessThan(idx('ToolExecutorImpl'));

    });

    it('construction order is deterministic across runs', async () => {
      const orders: string[][] = [];
      for (let i = 0; i < 3; i++) {
        callOrder.length = 0;
        await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });
        orders.push([...callOrder]);
      }
      expect(orders[1]).toEqual(orders[0]);
      expect(orders[2]).toEqual(orders[0]);
    });
  });

  describe('Assembly audit contract (phase155C)', () => {
    async function expectAssembleFailure(
      modulePath: string,
      className: string,
      methodName: 'ctor' | string = 'ctor',
      extraImpl: Record<string, unknown> = {},
    ): Promise<{ events: string[]; thrown: Error; auditTs: number[]; throwTs: number }> {
      const events: string[] = [];
      const auditTs: number[] = [];
      const prevImpl = mockAuditWrite.getMockImplementation();
      mockAuditWrite.mockImplementation((type: string, ...args: string[]) => {
        events.push([type, ...args].join('\t'));
        auditTs.push(Date.now());
      });

      const mod = await import(modulePath);
      const MockClass = mod[className] as ReturnType<typeof vi.fn>;

      if (methodName === 'ctor') {
        MockClass.mockImplementationOnce(() => {
          throw new Error(`injected ${className}`);
        });
      } else {
        MockClass.mockImplementationOnce(() => ({
          ...extraImpl,
          [methodName]: () => { throw new Error(`injected ${className}.${methodName}`); },
        }));
      }

      let thrown: Error | undefined;
      let throwTs = 0;
      try {
        await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });
      } catch (e) {
        thrown = e as Error;
        throwTs = Date.now();
      } finally {
        mockAuditWrite.mockImplementation(prevImpl || (() => {}));
      }

      expect(thrown).toBeDefined();
      return { events, thrown: thrown!, auditTs, throwTs };
    }

    it('llm construct failure → audit module=llm phase=construct + throw', async () => {
      const { events, thrown } = await expectAssembleFailure(
        '../../src/foundation/llm-orchestrator/orchestrator.js', 'LLMOrchestratorImpl', 'ctor',
      );
      expect(events.some(e => /^assemble_failed\tmodule=llm\tphase=construct\treason=injected/.test(e))).toBe(true);
      expect(thrown.message).toMatch(/LLMOrchestrator construct failed/);
    });

    it('tool_registry construct failure → audit module=tool_registry phase=construct + throw', async () => {
      const { events, thrown } = await expectAssembleFailure(
        '../../src/foundation/tools/registry.js', 'ToolRegistryImpl', 'ctor',
      );
      expect(events.some(e => /^assemble_failed\tmodule=tool_registry\tphase=construct\treason=injected/.test(e))).toBe(true);
      expect(thrown.message).toMatch(/ToolRegistry construct failed/);
    });

    it('skill_system 工厂失败（非首载错误）→ audit module=skill_system phase=construct + 原 error 原样上抛', async () => {
      const events: string[] = [];
      const prevImpl = mockAuditWrite.getMockImplementation();
      mockAuditWrite.mockImplementation((type: string, ...args: string[]) => {
        events.push([type, ...args].join('\t'));
      });

      mockSkillFactory.mockImplementationOnce(() => {
        throw new Error('injected SkillSystem');
      });

      let thrown: Error | undefined;
      try {
        await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });
      } catch (e) {
        thrown = e as Error;
      } finally {
        mockAuditWrite.mockImplementation(prevImpl || (() => {}));
      }

      expect(thrown).toBeDefined();
      expect(events.some(e => /^assemble_failed\tmodule=skill_system\tphase=construct\treason=injected/.test(e))).toBe(true);
      // phase 1872 Step G: owner 错误原样上抛（不 re-wrap、类型可辨）
      expect(thrown!.message).toBe('injected SkillSystem');
    });

    it('phase 1872 Step G: 首载失败（owner 类型化）→ audit module=skill_system phase=initialize', async () => {
      const events: string[] = [];
      const prevImpl = mockAuditWrite.getMockImplementation();
      mockAuditWrite.mockImplementation((type: string, ...args: string[]) => {
        events.push([type, ...args].join('\t'));
      });

      mockSkillFactory.mockImplementationOnce(() => {
        throw new SkillSystemInitialLoadError('SkillSystem initial load failed: dup boom');
      });

      let thrown: Error | undefined;
      try {
        await assemble(baseConfig, undefined, { createSkillSystem: mockSkillFactory });
      } catch (e) {
        thrown = e as Error;
      } finally {
        mockAuditWrite.mockImplementation(prevImpl || (() => {}));
      }

      expect(thrown).toBeInstanceOf(SkillSystemInitialLoadError);
      expect(events.some(e => /^assemble_failed\tmodule=skill_system\tphase=initialize\treason=SkillSystem initial load failed/.test(e))).toBe(true);
    });

    it('contract_manager construct failure → audit module=contract_manager phase=construct + throw', async () => {
      const { events, thrown } = await expectAssembleFailure(
        '../../src/core/contract/manager.js', 'ContractSystem', 'ctor',
      );
      expect(events.some(e => /^assemble_failed\tmodule=contract_manager\tphase=construct\treason=injected/.test(e))).toBe(true);
      expect(thrown.message).toMatch(/ContractSystem construct failed/);
    });

    it('task_system construct failure → audit module=task_system phase=construct + throw', async () => {
      const { events, thrown } = await expectAssembleFailure(
        '../../src/core/async-task-system/system.js', 'AsyncTaskSystem', 'ctor',
      );
      expect(events.some(e => /^assemble_failed\tmodule=task_system\tphase=construct\treason=injected/.test(e))).toBe(true);
      expect(thrown.message).toMatch(/AsyncTaskSystem construct failed/);
    });

    it('tool_executor construct failure → audit module=tool_executor phase=construct + throw', async () => {
      const { events, thrown } = await expectAssembleFailure(
        '../../src/foundation/tools/executor.js', 'ToolExecutorImpl', 'ctor',
      );
      expect(events.some(e => /^assemble_failed\tmodule=tool_executor\tphase=construct\treason=injected/.test(e))).toBe(true);
      expect(thrown.message).toMatch(/IToolExecutor construct failed/);
    });

    it('audit write happens BEFORE throw (时机契约)', async () => {
      const { auditTs, throwTs } = await expectAssembleFailure(
        '../../src/core/async-task-system/system.js', 'AsyncTaskSystem', 'ctor',
      );
      expect(auditTs.length).toBeGreaterThan(0);
      expect(auditTs[auditTs.length - 1]).toBeLessThanOrEqual(throwTs);
    });
  });
});
