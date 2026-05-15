import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { once } from 'events';
import { EventEmitter } from 'events';

// ============================================================================
// Hoisted mock state（供 vi.mock factory 引用，必须 hoisted）
// ============================================================================
const mockState = vi.hoisted(() => {
  const mockAuditWrite = vi.fn();
  const mockSnapshotCommit = vi.fn().mockResolvedValue({ ok: true });
  const mockRuntime = {
    initialize: vi.fn().mockResolvedValue(undefined),
    resumeContractIfPaused: vi.fn().mockResolvedValue(undefined),
  };
  const mockStreamWriter = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
  const mockHeartbeat = { isDue: vi.fn(() => false), fire: vi.fn() };
  const mockAssemble = vi.fn();
  const mockDisassemble = vi.fn().mockResolvedValue(undefined);

  let stopFn: (() => void) | null = null;
  const mockStartDaemonLoop = vi.fn(() => {
    let resolve: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    stopFn = () => resolve();
    return { promise, stop: stopFn };
  });

  const processHandlers: Record<string, Function[]> = {};

  return {
    mockAuditWrite,
    mockSnapshotCommit,
    mockRuntime,
    mockStreamWriter,
    mockHeartbeat,
    mockAssemble,
    mockDisassemble,
    mockStartDaemonLoop,
    get stopFn() { return stopFn; },
    set stopFn(v) { stopFn = v; },
    processHandlers,
  };
});



// EventEmitter for deterministic mock call detection (phase 779 Step C/D)
// Created at module level (after imports) to avoid vi.hoisted TDZ issues.
const mockStartDaemonLoopCallEvent = new EventEmitter();

// ============================================================================
// Module mocks（Step 1 D3 6 层映射）
// ============================================================================
vi.mock('../../src/assembly/index.js', () => ({
  assemble: mockState.mockAssemble,
  disassemble: mockState.mockDisassemble,
  LockConflictError: class LockConflictError extends Error {
    constructor(public clawId: string, message?: string) {
      super(message ?? `Lock conflict: ${clawId}`);
      this.name = 'LockConflictError';
    }
  },
}));

vi.mock('../../src/daemon/daemon-loop.js', () => ({
  startDaemonLoop: mockState.mockStartDaemonLoop,
}));

vi.mock('../../src/core/contract/manager.js', () => ({
  ContractSystem: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/foundation/audit/index.js', () => ({
  createSystemAudit: vi.fn(() => ({
    write: mockState.mockAuditWrite,
  })),
}));

vi.mock('../../src/foundation/config/index.js', () => ({
  loadGlobalConfig: vi.fn(() => ({})),
  loadClawConfig: vi.fn(() => ({})),
  getClawforumRoot: vi.fn(() => '/tmp/test-root'),
  getClawDir: vi.fn((name: string) => `/tmp/test-root/claws/${name}`),
  getMotionDir: vi.fn(() => '/tmp/test-root/motion'),
  resolveAgentDir: vi.fn((id: string) => id === 'motion' ? '/tmp/test-root/motion' : `/tmp/test-root/claws/${id}`),
}));

// node 内置 mock
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn((path: string) => {
      if (path.endsWith('AGENTS.md')) return 'test-prompt-content';
      if (path.endsWith('pid')) return String(process.pid);
      throw new Error(`unexpected readFileSync: ${path}`);
    }),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),  // heartbeat 清理空列表
    mkdirSync: vi.fn(),
  };
});

class ProcessExitError extends Error {
  constructor(public code: number | undefined) { super(`process.exit(${code})`); }
}

// ============================================================================
// process spy lifecycle helpers（β 治本 / phase 785 Step A）
//   - spy 归 describe 拥有 / beforeEach 重建 / afterEach restoreAllMocks 清除
//   - module-level 不持 vi.spyOn 句柄 / 0 跨 file 污染
// ============================================================================
function installProcessSpies(): void {
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
    if (!mockState.processHandlers[event]) mockState.processHandlers[event] = [];
    mockState.processHandlers[event].push(handler);
    return process;
  }) as any);

  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as any);

  // 保护 mockStartDaemonLoop 不受 restoreAllMocks 影响（vi.fn mockRestore 会还原为 hoisted 原始实现）
  mockState.mockStartDaemonLoop.mockImplementation((options: any) => {
    let resolve: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    mockState.stopFn = () => resolve();
    mockStartDaemonLoopCallEvent.emit('call', options);
    return { promise, stop: mockState.stopFn };
  });
}

// ============================================================================
// Helpers
// ============================================================================
function makeMockInstances(overrides?: Partial<any>) {
  return {
    clawId: 'test',
    runtime: mockState.mockRuntime,
    streamWriter: mockState.mockStreamWriter,
    snapshot: { commit: mockState.mockSnapshotCommit },
    auditWriter: { write: mockState.mockAuditWrite },
    heartbeat: mockState.mockHeartbeat,
    processManager: { /* not destructured */ },
    cronRunner: undefined,
    gateway: undefined,
    ...overrides,
  };
}

async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
  // 让真实 I/O（如 ProcessManager.writeAtomic）的 libuv callback 有机会执行
  await new Promise(resolve => setTimeout(resolve, 50));
}

// ============================================================================
// Tests
// ============================================================================
import { daemonCommand } from '../../src/daemon/daemon.js';

describe('daemonCommand - A4a startup success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockState.processHandlers).forEach(k => delete mockState.processHandlers[k]);
    installProcessSpies();
    mockState.mockSnapshotCommit.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    if (mockState.stopFn) mockState.stopFn();
    mockState.stopFn = null;
    vi.restoreAllMocks();
  });

  it('claw: assemble 成功 → daemon_start audit + snapshot.commit 被调', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));

    // 触发：daemonCommand 启动后立即被 startDaemonLoop 阻塞在 await promise
    // 通过 stopFn 释放 promise 让 daemonCommand 返回
    const cmdPromise = daemonCommand('test-claw');

    // Wait for mockStartDaemonLoop call event instead of fragile flushMicrotasks (phase 779 Step C)
    await once(mockStartDaemonLoopCallEvent, 'call');
    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => {});  // 忽略 process.exit 抛错（若有）

    // 断言
    expect(mockState.mockAssemble).toHaveBeenCalledWith(expect.objectContaining({
      identity: 'claw',
      clawId: 'test-claw',
    }));
    expect(mockState.mockRuntime.initialize).toHaveBeenCalled();
    expect(mockState.mockAuditWrite).toHaveBeenCalledWith('daemon_start', expect.stringContaining('sha256:'));
    expect(mockState.mockSnapshotCommit).toHaveBeenCalled();
  });

  it('motion: assemble 成功 + identity=motion + onInboxMessages undefined (phase411)', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'motion' }));

    const cmdPromise = daemonCommand('motion');

    // Wait for mockStartDaemonLoop call event (phase 779 Step C)
    await once(mockStartDaemonLoopCallEvent, 'call');
    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => {});

    // 断言：motion 身份分支
    expect(mockState.mockAssemble).toHaveBeenCalledWith(expect.objectContaining({
      identity: 'motion',
    }));

    // phase411: onInboxMessages 已移除（review_request 由 ContractSystem.contract_completed 事件驱动）
    expect(mockState.mockStartDaemonLoop).toHaveBeenCalledWith(expect.objectContaining({
      label: '[motion daemon]',
      motion: expect.objectContaining({ onInboxMessages: undefined }),
    }));
  });
});


describe('daemonCommand - A4a startup failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockState.processHandlers).forEach(k => delete mockState.processHandlers[k]);
    installProcessSpies();
    mockState.mockSnapshotCommit.mockResolvedValue({ ok: true });
    mockState.mockRuntime.initialize.mockResolvedValue(undefined);
    mockState.mockRuntime.resumeContractIfPaused.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('it #3: assemble LockConflictError → audit module=lockfile + console + exit 1', async () => {
    const { LockConflictError } = await import('../../src/foundation/process-manager/index.js');
    const lockErr = new LockConflictError('test-claw');
    mockState.mockAssemble.mockRejectedValue(lockErr);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(daemonCommand('test-claw')).rejects.toThrow('process.exit(1)');

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Lock conflict'));
    // phase189 §7.A3 清零：LockConflictError 分支补 audit
    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=lockfile',
      'phase=preconstruct',
      expect.stringMatching(/reason=.*Lock conflict/),
    );
    errSpy.mockRestore();
  });

  it('it #4: assemble 其他失败 → audit module=pre_assemble + console + exit 1', async () => {
    mockState.mockAssemble.mockRejectedValue(new Error('mock assemble crash'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(daemonCommand('test-claw')).rejects.toThrow('process.exit(1)');

    expect(errSpy).toHaveBeenCalledWith(
      '[daemon] assemble failed:',
      'mock assemble crash',
    );
    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=pre_assemble',
      'phase=preconstruct',
      expect.stringMatching(/reason=.*mock assemble crash/),
    );
    errSpy.mockRestore();
  });

  it('it #5: runtime.initialize 失败 → assemble_failed audit + exit 1', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));
    mockState.mockRuntime.initialize.mockRejectedValue(new Error('init failed'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(daemonCommand('test-claw')).rejects.toThrow('process.exit(1)');

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=runtime',
      'phase=post_assemble_init',
      expect.stringContaining('reason=init failed'),
    );
    errSpy.mockRestore();
  });

  it('it #6: snapshot.commit uncategorized → snapshot_commit_uncategorized audit', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));
    mockState.mockSnapshotCommit.mockResolvedValue({
      ok: false,
      error: { kind: 'uncategorized', exitCode: 128, stderr: 'test-stderr' },
    });

    const cmdPromise = daemonCommand('test-claw');
    await flushMicrotasks(20);  // 等 .then 链跑完
    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => {});

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'snapshot_commit_uncategorized',
      'context=daemon-start',
      'exitCode=128',
    );
  });

  it('it #7: snapshot.commit rejects → snapshot_commit_failed audit', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));
    mockState.mockSnapshotCommit.mockRejectedValue(new Error('git not found'));

    const cmdPromise = daemonCommand('test-claw');
    await flushMicrotasks(20);
    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => {});

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'snapshot_commit_failed',
      'context=daemon-start',
      expect.stringContaining('reason=git not found'),
    );
  });
});


describe('daemonCommand - A4d shutdown signal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockState.processHandlers).forEach(k => delete mockState.processHandlers[k]);
    installProcessSpies();
    mockState.mockSnapshotCommit.mockResolvedValue({ ok: true });
    mockState.mockRuntime.initialize.mockResolvedValue(undefined);
    mockState.mockRuntime.resumeContractIfPaused.mockResolvedValue(undefined);
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));
    mockState.mockDisassemble.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('it #8: SIGTERM → shutdown → disassemble + selfRemovePid + exit 0', async () => {
    const selfRemovePidSpy = vi.spyOn(ProcessManager.prototype, 'selfRemovePid').mockResolvedValue(undefined);

    const cmdPromise = daemonCommand('test-claw');
    await flushMicrotasks();

    // 触发 SIGTERM handler
    const sigtermHandler = mockState.processHandlers['SIGTERM']?.[0];
    expect(sigtermHandler).toBeDefined();

    await expect(async () => {
      await sigtermHandler!();
    }).rejects.toThrow('process.exit(0)');

    expect(mockState.mockDisassemble).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: mockState.mockRuntime }),
      'SIGTERM',
    );
    expect(selfRemovePidSpy).toHaveBeenCalledWith('test-claw');
    selfRemovePidSpy.mockRestore();

    await cmdPromise.catch(() => {});
  });

  it('it #9: SIGINT → shutdown → disassemble + exit 0', async () => {
    const cmdPromise = daemonCommand('test-claw');
    await flushMicrotasks();

    const sigintHandler = mockState.processHandlers['SIGINT']?.[0];
    expect(sigintHandler).toBeDefined();

    await expect(async () => {
      await sigintHandler!();
    }).rejects.toThrow('process.exit(0)');

    expect(mockState.mockDisassemble).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: mockState.mockRuntime }),
      'SIGINT',
    );

    await cmdPromise.catch(() => {});
  });
});


describe('daemonCommand - A4d crash handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockState.processHandlers).forEach(k => delete mockState.processHandlers[k]);
    installProcessSpies();
    mockState.mockSnapshotCommit.mockResolvedValue({ ok: true });
    mockState.mockRuntime.initialize.mockResolvedValue(undefined);
    mockState.mockRuntime.resumeContractIfPaused.mockResolvedValue(undefined);
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('it #10: uncaughtException → daemon_crash audit + exit 1', async () => {
    const cmdPromise = daemonCommand('test-claw');
    await flushMicrotasks();

    const handler = mockState.processHandlers['uncaughtException']?.[0];
    expect(handler).toBeDefined();

    const testErr = new Error('test uncaught');
    testErr.stack = 'mock-stack';

    expect(() => handler!(testErr)).toThrow('process.exit(1)');

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'daemon_crash',
      expect.stringMatching(/^error=test uncaught\nmock-stack/),
    );

    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => {});
  });

  it('it #11: unhandledRejection → daemon_crash audit + exit 1', async () => {
    const cmdPromise = daemonCommand('test-claw');
    await flushMicrotasks();

    const handler = mockState.processHandlers['unhandledRejection']?.[0];
    expect(handler).toBeDefined();

    expect(() => handler!('reject reason string')).toThrow('process.exit(1)');

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'daemon_crash',
      'error=reject reason string',
    );

    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => {});
  });
});


describe('daemonCommand - review_request dispatch (phase184)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockState.processHandlers).forEach(k => delete mockState.processHandlers[k]);
    installProcessSpies();
    mockState.mockSnapshotCommit.mockResolvedValue({ ok: true });
    mockState.mockRuntime.initialize.mockResolvedValue(undefined);
    mockState.mockRuntime.resumeContractIfPaused.mockResolvedValue(undefined);
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'motion' }));
  });

  afterEach(() => {
    if (mockState.stopFn) mockState.stopFn();
    mockState.stopFn = null;
    vi.restoreAllMocks();
  });

  it('phase411: onInboxMessages 始终 undefined（review_request 已由 ContractSystem 事件驱动）', async () => {
    const cmdPromise = daemonCommand('motion');

    // Guard: ensure mockStartDaemonLoop has been called before reading calls[0] (phase 779 Step D / B.flaky-2)
    await once(mockStartDaemonLoopCallEvent, 'call');

    const options = mockState.mockStartDaemonLoop.mock.calls[0][0];
    expect(options.motion?.onInboxMessages).toBeUndefined();

    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => {});
  });

  it('claw 模式下 onInboxMessages 未注册（undefined）', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));

    const cmdPromise = daemonCommand('test-claw');

    // Guard: ensure mockStartDaemonLoop has been called before reading calls[0] (phase 779 Step D / B.flaky-2)
    await once(mockStartDaemonLoopCallEvent, 'call');

    const options = mockState.mockStartDaemonLoop.mock.calls[0][0];
    expect(options.motion?.onInboxMessages).toBeUndefined();

    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => {});
  });
});
