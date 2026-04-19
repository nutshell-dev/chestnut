import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assemble } from '../../src/assembly/assemble.js';
import { LockConflictError } from '../../src/assembly/index.js';

// ============================================================================
// Shared mock instances (captured by vi.mock factories)
// ============================================================================
const mockAuditWrite = vi.fn();
const mockRuntime = {
  setParentStreamLog: vi.fn(),
  setContractNotifyCallback: vi.fn(),
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
// Module mocks
// ============================================================================
vi.mock('../../src/foundation/audit/writer.js', () => ({
  AuditWriter: vi.fn(() => ({ write: mockAuditWrite })),
}));

vi.mock('../../src/foundation/snapshot/index.js', () => ({
  Snapshot: vi.fn(() => mockSnapshot),
  SNAPSHOT_IGNORE_PATTERNS: ['.git', 'node_modules'],
}));

vi.mock('../../src/foundation/stream/writer.js', () => ({
  StreamWriter: vi.fn(() => mockStreamWriter),
}));

vi.mock('../../src/foundation/fs/node-fs.js', () => ({
  NodeFileSystem: vi.fn(),
}));

vi.mock('../../src/cli/commands/process-manager-factory.js', () => ({
  createAgentProcessManager: vi.fn(() => mockProcessManager),
}));

vi.mock('../../src/core/runtime.js', () => ({
  ClawRuntime: vi.fn(() => mockRuntime),
}));

vi.mock('../../src/core/motion/runtime.js', () => ({
  MotionRuntime: vi.fn(function () {
    return mockRuntime;
  }),
}));

vi.mock('../../src/core/heartbeat.js', () => ({
  Heartbeat: vi.fn(() => mockHeartbeat),
}));

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

vi.mock('../../src/core/cron/jobs/deep-dream.js', () => ({
  runDeepDream: vi.fn(),
}));

vi.mock('../../src/core/cron/jobs/random-dream.js', () => ({
  runRandomDream: vi.fn(),
}));

vi.mock('../../src/core/cron/jobs/contract-observer.js', () => ({
  runContractObserver: vi.fn(),
}));

vi.mock('../../src/cli/config.js', () => ({
  buildLLMConfig: vi.fn(() => ({ provider: 'mock' })),
}));

vi.mock('../../src/constants.js', () => ({
  DEFAULT_MAX_STEPS: 30,
  DEFAULT_MAX_CONCURRENT_TASKS: 5,
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
    mockAuditWrite.mockClear();
    mockSnapshot.init.mockResolvedValue({ ok: true });
    mockSnapshot.commit.mockResolvedValue({ ok: true });
    mockProcessManager.acquireLock.mockReturnValue(undefined);
  });

  // --------------------------------------------------------------------------
  // 分支穷尽
  // --------------------------------------------------------------------------
  it('motion + cron.enabled + heartbeat>0 → 含 cronRunner 和 heartbeat', async () => {
    const result = await assemble(baseConfig);

    expect(result.cronRunner).toBe(mockCronRunner);
    expect(result.heartbeat).toBe(mockHeartbeat);
    expect(result.clawId).toBe('motion');
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

  it('claw identity → 无 cronRunner 无 heartbeat', async () => {
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
      throw new Error('already locked');
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
    const { StreamWriter } = await import('../../src/foundation/stream/writer.js');
    (StreamWriter as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
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

  it('setContractNotifyCallback 回调应写 user_notify 到 streamWriter', async () => {
    await assemble(baseConfig);
    const callback = mockRuntime.setContractNotifyCallback.mock.calls[0][0];
    callback('test_type', { msg: 'hello' });

    expect(mockStreamWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: expect.any(Number),
        type: 'user_notify',
        subtype: 'test_type',
        msg: 'hello',
      })
    );
  });

  it('ProcessManager 构造失败 → assemble_failed + 抛 Error', async () => {
    const { createAgentProcessManager } = await import('../../src/cli/commands/process-manager-factory.js');
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
    const { Snapshot } = await import('../../src/foundation/snapshot/index.js');
    (Snapshot as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
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
    const { MotionRuntime } = await import('../../src/core/motion/runtime.js');
    (MotionRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
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
    const { Heartbeat } = await import('../../src/core/heartbeat.js');
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
    const { runDeepDream } = await import('../../src/core/cron/jobs/deep-dream.js');
    const { runRandomDream } = await import('../../src/core/cron/jobs/random-dream.js');
    const { runContractObserver } = await import('../../src/core/cron/jobs/contract-observer.js');

    expect(runDiskMonitor).toHaveBeenCalled();
    expect(runLlmStats).toHaveBeenCalled();
    expect(runDeepDream).toHaveBeenCalled();
    expect(runRandomDream).toHaveBeenCalled();
    expect(runContractObserver).toHaveBeenCalled();
  });
});
