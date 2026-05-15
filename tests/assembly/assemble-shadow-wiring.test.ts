import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assemble } from '../../src/assembly/assemble.js';
import type { RuntimeDependencies } from '../../src/core/runtime/types.js';

// ============================================================================
// Shared mock instances
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
// Capture createRuntime deps
// ============================================================================
let capturedDeps: RuntimeDependencies | null = null;

// ============================================================================
// Module mocks (mirror assemble.test.ts minimal set for motion identity)
// ============================================================================
vi.mock('../../src/foundation/audit/writer.js', () => ({
  AuditWriter: vi.fn(() => ({ write: mockAuditWrite })),
  AUDIT_FILE: 'audit.tsv',
}));

vi.mock('../../src/foundation/snapshot/index.js', () => ({
  Snapshot: vi.fn(() => mockSnapshot),
  SNAPSHOT_IGNORE_PATTERNS: ['.git', 'node_modules'],
  createSnapshot: vi.fn(() => mockSnapshot),
}));

vi.mock('../../src/foundation/stream/writer.js', () => ({
  StreamWriter: vi.fn(() => mockStreamWriter),
}));

vi.mock('../../src/foundation/stream/index.js', () => ({
  createStreamWriter: vi.fn(() => mockStreamWriter),
  createStreamReader: vi.fn(),
  STREAM_FILE: 'stream.jsonl',
  findRecentTurnStartOffset: vi.fn().mockReturnValue(0),
}));

vi.mock('../../src/foundation/fs/node-fs.js', () => ({
  NodeFileSystem: vi.fn(() => ({ ensureDir: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('../../src/assembly/cleanup.js', () => ({
  cleanupOrphanedTemp: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/foundation/process-manager/agent-factory.js', () => ({
  createAgentProcessManager: vi.fn(() => mockProcessManager),
}));

vi.mock('../../src/core/runtime/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/runtime/index.js')>();
  return {
    ...mod,
    createRuntime: vi.fn((opts) => {
      capturedDeps = opts.dependencies;
      return mockRuntime;
    }),
    buildMotionSystemPrompt: vi.fn(() => Promise.resolve('')),
  };
});

vi.mock('../../src/core/cron/runner.js', () => ({
  CronRunner: vi.fn(() => mockCronRunner),
  parseSchedule: vi.fn((s: string) => s),
}));

vi.mock('../../src/core/cron/jobs/disk-monitor.js', () => ({
  runDiskMonitor: vi.fn(),
}));

vi.mock('../../src/core/cron/jobs/llm-stats.js', () => ({
  runLlmStats: vi.fn(),
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
}));

vi.mock('../../src/foundation/llm-orchestrator/orchestrator.js', () => ({
  LLMOrchestratorImpl: vi.fn(() => ({ close: vi.fn(), healthCheck: vi.fn(), getProviderInfo: vi.fn() })),
}));

vi.mock('../../src/foundation/monitor/monitor.js', () => ({
  JsonlLogger: vi.fn(() => ({ log: vi.fn(), close: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/registry.js', () => ({
  ToolRegistryImpl: vi.fn(() => ({ register: vi.fn(), getForProfile: vi.fn(() => []), getAll: vi.fn(() => []), formatForLLM: vi.fn(), unregister: vi.fn(), get: vi.fn() })),
}));

vi.mock('../../src/foundation/tools/executor.js', () => {
  const Ctor = vi.fn(() => ({ execute: vi.fn() }));
  return {
    ToolExecutorImpl: Ctor,
    createToolExecutor: vi.fn((...args: any[]) => new (Ctor as any)(...args)),
  };
});

vi.mock('../../src/foundation/skill-system/registry.js', () => ({
  SkillSystem: vi.fn(() => ({ loadAll: vi.fn().mockResolvedValue(undefined), getSkills: vi.fn(() => []) })),
}));

vi.mock('../../src/core/contract/manager.js', () => ({
  ContractSystem: vi.fn(() => ({ setOnNotify: vi.fn(), loadPaused: vi.fn(), resume: vi.fn(), onContractCompleted: vi.fn(() => () => {}) })),
}));

vi.mock('../../src/core/async-task-system/system.js', () => ({
  AsyncTaskSystem: vi.fn(() => ({ initialize: vi.fn().mockResolvedValue(undefined), startDispatch: vi.fn(), shutdown: vi.fn(), addPostProcessor: vi.fn(), setMainDialogStore: vi.fn() })),
}));

vi.mock('../../src/core/dialog/injector.js', () => {
  const Ctor = vi.fn(() => ({ buildSystemPrompt: vi.fn(), buildParts: vi.fn() }));
  return {
    ContextInjector: Ctor,
    createContextInjector: vi.fn((...args: any[]) => new (Ctor as any)(...args)),
  };
});

vi.mock('../../src/foundation/tools/context.js', () => ({
  ExecContextImpl: vi.fn((opts) => ({
    ...opts,
    signal: undefined,
    dialogMessages: [],
    incrementStep: vi.fn(),
    requestStop: vi.fn(),
  })),
}));

vi.mock('../../src/foundation/messaging/index.js', () => {
  const MockInboxWriter = vi.fn().mockImplementation(() => ({
    write: vi.fn().mockResolvedValue(undefined),
    writeSync: vi.fn(),
  }));
  (MockInboxWriter as any).readMeta = vi.fn();
  return {
    InboxReader: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined), drainInbox: vi.fn(() => []), markDone: vi.fn(), markFailed: vi.fn() })),
    OutboxWriter: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
    InboxWriter: MockInboxWriter,
    createInboxReader: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined), drainInbox: vi.fn(() => []), markDone: vi.fn(), markFailed: vi.fn() })),
    createOutboxWriter: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
    readInboxFileMeta: vi.fn(),
    notifyInbox: vi.fn(),
  };
});

vi.mock('../../src/foundation/dialog-store/index.js', () => ({
  DialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), systemPrompt: '' })),
  createDialogStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn(), archive: vi.fn(), restorePrefix: vi.fn() })),
}));

vi.mock('../../src/foundation/config/index.js', () => ({
  buildLLMConfig: vi.fn(() => ({ provider: 'mock' })),
}));

vi.mock('../../src/constants.js', () => ({
  DEFAULT_MAX_STEPS: 30,
  DEFAULT_MAX_CONCURRENT_TASKS: 5,
  GATEWAY_ASK_USER_TIMEOUT_MS: 30 * 60 * 1000,
}));

vi.mock('../../src/core/evolution-system/index.js', () => ({
  createEvolutionSystem: vi.fn(() => ({})),
}));

vi.mock('../../src/core/gateway/index.js', () => ({
  createGateway: vi.fn(() => ({ isOnline: vi.fn().mockReturnValue(false) })),
  createAskUserTool: vi.fn(() => ({ name: 'ask_user' })),
}));

// ============================================================================
// Tests
// ============================================================================
describe('assemble shadow wiring (phase 784)', () => {
  let tempDir: string;

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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase784-'));
    capturedDeps = null;
    vi.clearAllMocks();
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
    mockProcessManager.acquireLock.mockReturnValue(undefined);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('lazy injects registry and mainDialogStore into execContext (phase 766/768 regression)', async () => {
    await assemble({ ...baseConfig, clawDir: tempDir });

    expect(capturedDeps).not.toBeNull();
    expect(capturedDeps!.execContext.registry).toBe(capturedDeps!.toolRegistry);
    expect(capturedDeps!.execContext.mainDialogStore).toBe(capturedDeps!.sessionManager);
    expect(capturedDeps!.execContext.isShadow).toBeUndefined();
    expect(capturedDeps!.execContext.callerType).toBe('claw');
  });
});
