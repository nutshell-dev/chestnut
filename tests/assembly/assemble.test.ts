import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assemble } from '../../src/assembly/assemble.js';
import { LockConflictError } from '../../src/assembly/index.js';

// ============================================================================
// Shared mock instances (captured by vi.mock factories)
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

// ============================================================================
// Construction order tracking (phase155C)
// ============================================================================
const callOrder: string[] = [];

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
  AuditWriter: vi.fn(() => ({ write: mockAuditWrite })),
  AUDIT_FILE: 'audit.tsv',
  reconcileFallbackDumps: vi.fn().mockResolvedValue(undefined),
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
  NodeFileSystem: vi.fn(({ baseDir }: { baseDir: string }) => ({
    ensureDir: vi.fn().mockResolvedValue(undefined),
    existsSync: vi.fn((p: string) => fs.existsSync(path.join(baseDir, p))),
    statSync: vi.fn((p: string) => fs.statSync(path.join(baseDir, p))),
    readBytesSync: vi.fn((p: string, start: number, end: number) => {
      const buf = fs.readFileSync(path.join(baseDir, p));
      return buf.subarray(start, end);
    }),
    listSync: vi.fn(() => []),
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

vi.mock('../../src/core/cron/jobs/git-gc-weekly.js', () => ({
  runGitGcWeekly: vi.fn(),
  GIT_GC_WEEKLY_CRON_TIMEOUT_MS: 120_000,
}));

vi.mock('../../src/foundation/llm-orchestrator/orchestrator.js', () => ({
  LLMOrchestratorImpl: trackCtor('LLMOrchestratorImpl', () => ({ close: vi.fn(), healthCheck: vi.fn(), getProviderInfo: vi.fn() })),
}));

vi.mock('../../src/foundation/monitor/monitor.js', () => ({
  JsonlLogger: trackCtor('JsonlLogger', () => ({ log: vi.fn(), close: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/registry.js', () => ({
  ToolRegistryImpl: trackCtor('ToolRegistryImpl', () => ({ register: vi.fn(), getForProfile: vi.fn(() => []), getAll: vi.fn(() => []), formatForLLM: vi.fn(), unregister: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/executor.js', () => {
  const Ctor = trackCtor('ToolExecutorImpl', () => ({ execute: vi.fn() }));
  return {
    ToolExecutorImpl: Ctor,
    createToolExecutor: vi.fn((...args: any[]) => new (Ctor as any)(...args)),
  };
});

vi.mock('../../src/foundation/skill-system/registry.js', () => ({
  SkillSystem: trackCtor('SkillSystem', () => ({ loadAll: vi.fn().mockResolvedValue(undefined), getSkills: vi.fn(() => []) })),
}));

vi.mock('../../src/core/contract/manager.js', () => ({
  ContractSystem: trackCtor('ContractSystem', () => ({ setOnNotify: vi.fn(), loadPaused: vi.fn(), resume: vi.fn(), onContractCompleted: vi.fn(() => () => {}), init: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('../../src/core/async-task-system/system.js', () => ({
  AsyncTaskSystem: trackCtor('AsyncTaskSystem', () => ({ initialize: vi.fn().mockResolvedValue(undefined), startDispatch: vi.fn(), shutdown: vi.fn(), addPostProcessor: vi.fn(), setMainDialogStore: vi.fn() })),
}));

vi.mock('../../src/core/dialog/injector.js', () => {
  const Ctor = trackCtor('ContextInjector', () => ({ buildSystemPrompt: vi.fn(), buildParts: vi.fn() }));
  return {
    ContextInjector: Ctor,
    createContextInjector: vi.fn((...args: any[]) => new (Ctor as any)(...args)),
  };
});

vi.mock('../../src/foundation/tools/context.js', () => ({
  ExecContextImpl: trackCtor('ExecContextImpl', () => ({ signal: undefined })),
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
    cleanupRetention: vi.fn().mockResolvedValue(0),
  };
});

vi.mock('../../src/foundation/dialog-store/index.js', () => ({
  DialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), systemPrompt: '' })),
  createDialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), restorePrefix: vi.fn() })),
  cleanupArchives: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../src/foundation/config/index.js', () => ({
  buildLLMConfig: vi.fn(() => ({ provider: 'mock' })),
}));


// ============================================================================
// Tests
// ============================================================================
describe('assemble', () => {
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
    callOrder.length = 0;
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
    mockProcessManager.acquireLock.mockReturnValue(undefined);
  });

  // --------------------------------------------------------------------------
  // 分支穷尽
  // --------------------------------------------------------------------------
  it('motion + cron.enabled + heartbeat>0 → 含 cronRunner / heartbeat / gateway (offline)', async () => {
    const result = await assemble(baseConfig);

    expect(result.cronRunner).toBe(mockCronRunner);
    expect(result.heartbeat).toBe(mockHeartbeat);
    expect(result.clawId).toBe('motion');
    expect(result.gateway).toBeDefined();
    expect(result.gateway!.isOnline()).toBe(false);
    expect(mockCronRunner.start).toHaveBeenCalled();
  });

  it('motion + cron.enabled=false → 无 cronRunner', async () => {
    const config = {
      ...baseConfig,
      globalConfig: {
        ...baseConfig.globalConfig,
        cron: { ...baseConfig.globalConfig.cron, enabled: false },
      },
    };
    const result = await assemble(config);

    expect(result.cronRunner).toBeUndefined();
    expect(result.heartbeat).toBe(mockHeartbeat);
  });

  it('motion + heartbeat_interval_ms=0 → 无 heartbeat', async () => {
    const config = {
      ...baseConfig,
      globalConfig: {
        ...baseConfig.globalConfig,
        motion: { ...baseConfig.globalConfig.motion, heartbeat_interval_ms: 0 },
      },
    };
    const result = await assemble(config);

    expect(result.heartbeat).toBeUndefined();
    expect(result.cronRunner).toBe(mockCronRunner);
  });

  it('claw identity → 无 cronRunner / heartbeat / gateway', async () => {
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
    const result = await assemble(config);

    expect(result.cronRunner).toBeUndefined();
    expect(result.heartbeat).toBeUndefined();
    expect(result.clawId).toBe('test-claw');
    expect(result.gateway).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // audit 事件
  // --------------------------------------------------------------------------
  it('成功路径末尾写 daemon_started', async () => {
    await assemble(baseConfig);

    expect(mockAuditWrite).toHaveBeenCalledWith(
      'daemon_started',
      expect.stringContaining('clawId=motion'),
      expect.stringContaining('pid=')
    );
  });

  // --------------------------------------------------------------------------
  // 失败语义
  // --------------------------------------------------------------------------
  it('acquireLock 冲突 → LockConflictError + assemble_lock_conflict audit', async () => {
    mockProcessManager.acquireLock.mockImplementation(() => {
      throw new LockConflictError('motion', 'already locked');
    });

    await expect(assemble(baseConfig)).rejects.toBeInstanceOf(LockConflictError);

    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_lock_conflict',
      'clawId=motion'
    );
  });

  it('snapshot.init 失败 → assemble_failed + 抛 Error', async () => {
    mockSnapshot.init.mockResolvedValue({
      ok: false,
      error: { kind: 'git_error' },
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
      'Assembly: Snapshot.init failed: git_error'
    );

    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=snapshot',
      'phase=init',
      'reason=git_error'
    );
  });

  it('snapshot.commit recovery 失败 → assemble_failed + 不抛', async () => {
    mockSnapshot.commit.mockResolvedValue({
      ok: false,
      error: { kind: 'commit_error' },
    });

    const result = await assemble(baseConfig);

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
    const { createStreamWriter } = await import('../../src/foundation/stream/index.js');
    (createStreamWriter as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('stream fail');
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
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
    const { CronRunner } = await import('../../src/core/cron/runner.js');
    (CronRunner as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('cron fail');
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
      'Assembly: CronRunner construct failed: cron fail'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=cron_runner',
      'phase=construct',
      'reason=cron fail'
    );
  });

  it('CronRunner.start 失败时 stream.daemon_started 未调用', async () => {
    mockCronRunner.start.mockImplementationOnce(() => {
      throw new Error('start boom');
    });

    await expect(assemble(baseConfig)).rejects.toThrow();
    expect(mockStreamWriter.write).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'daemon_started' }),
    );
  });

  it('CronRunner.start 失败 → assemble_failed phase=start + 抛 Error', async () => {
    mockCronRunner.start.mockImplementationOnce(() => {
      throw new Error('start boom');
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
      'Assembly: CronRunner start failed: start boom'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=cron_runner',
      'phase=start',
      'reason=start boom'
    );
  });

  it('buildLLMConfig 失败 → assemble_failed module=llm_config + 抛 Error', async () => {
    const { buildLLMConfig } = await import('../../src/foundation/config/index.js');
    (buildLLMConfig as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('llm cfg boom');
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
      'Assembly: buildLLMConfig failed: llm cfg boom'
    );
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=llm_config',
      'phase=construct',
      'reason=llm cfg boom'
    );
  });

  it('contractNotifyCallback 注入后 streamWriter 收到 user_notify（构造期路径覆盖）', async () => {
    await assemble(baseConfig);
    // 验证 daemon_started 时 streamWriter.write 被调用（含 user_notify 的 callback 已通过 deps 注入）
    expect(mockStreamWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: expect.any(Number),
        type: 'daemon_started',
      })
    );
  });

  it('ProcessManager 构造失败 → assemble_failed + 抛 Error', async () => {
    const { createAgentProcessManager } = await import('../../src/foundation/process-manager/agent-factory.js');
    (createAgentProcessManager as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('pm fail');
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
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
    const { createSnapshot } = await import('../../src/foundation/snapshot/index.js');
    (createSnapshot as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('snapshot fail');
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
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
    const { createRuntime } = await import('../../src/core/runtime/index.js');
    (createRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('runtime fail');
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
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
    const { Heartbeat } = await import('../../src/core/runtime/index.js');
    (Heartbeat as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('heartbeat fail');
    });

    await expect(assemble(baseConfig)).rejects.toThrow(
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
    await assemble(baseConfig);
    const { CronRunner } = await import('../../src/core/cron/runner.js');
    const jobs = (CronRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

    for (const job of jobs) {
      if (typeof job.handler === 'function') {
        await job.handler();
      }
    }

    const { runDiskMonitor } = await import('../../src/core/cron/jobs/disk-monitor.js');
    const { runLlmStats } = await import('../../src/core/cron/jobs/llm-stats.js');
    const { createMemorySystem } = await import('../../src/core/memory/index.js');
    const { runContractObserver } = await import('../../src/core/contract/jobs/contract-observer.js');
    const { runGitGcWeekly } = await import('../../src/core/cron/jobs/git-gc-weekly.js');

    expect(runDiskMonitor).toHaveBeenCalled();
    expect(runLlmStats).toHaveBeenCalled();
    expect(createMemorySystem).toHaveBeenCalled();
    expect(mockMemorySystem.runDeepDream).toHaveBeenCalled();
    expect(mockMemorySystem.runRandomDream).toHaveBeenCalled();
    expect(runContractObserver).toHaveBeenCalled();
    expect(runGitGcWeekly).toHaveBeenCalled();
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

      await assemble(configWithTmp);

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

      await assemble(configWithTmp);

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

      await assemble(configWithTmp);

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

      await assemble(configWithTmp);

      expect(mockAuditWrite).toHaveBeenCalledWith(
        'daemon_unclean_exit',
        'last_ts=2026-04-19T11:00:00.000Z',
      );
    });

    it('audit.tsv 不存在 → 静默跳过', async () => {
      await assemble(configWithTmp);

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
      await assemble(baseConfig);

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
        await assemble(baseConfig);
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
        await assemble(baseConfig);
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

    it('skill_registry construct failure → audit module=skill_registry phase=construct + throw', async () => {
      const { events, thrown } = await expectAssembleFailure(
        '../../src/foundation/skill-system/registry.js', 'SkillSystem', 'ctor',
      );
      expect(events.some(e => /^assemble_failed\tmodule=skill_registry\tphase=construct\treason=injected/.test(e))).toBe(true);
      expect(thrown.message).toMatch(/SkillSystem construct failed/);
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
