import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../helpers/daemon-dir.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { once } from 'events';
import { EventEmitter } from 'events';

/**
 * Libuv I/O callback settle (50ms): flushMicrotasks 内给真实 I/O callback 机会执行.
 * Derivation: > microtask flush / 给 ProcessManager.writeAtomic 等 libuv 异步 callback land.
 */
const LIBUV_IO_SETTLE_MS = 50;

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
const mockProcessOnEvent = new EventEmitter();       // NEW (phase 790)
const mockAuditEvent = new EventEmitter();           // NEW (phase 790)

// ============================================================================
// Module mocks（Step 1 D3 6 层映射）
// ============================================================================

vi.mock('../../src/daemon/daemon-loop.js', () => ({
  startDaemonLoop: mockState.mockStartDaemonLoop,
}));

vi.mock('../../src/core/contract/manager.js', () => ({
  ContractSystem: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/foundation/audit/index.js', () => ({
  createSystemAudit: vi.fn(() => ({
    write: mockState.mockAuditWrite,
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  })),
}));

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getChestnutRoot: vi.fn(() => '/tmp/test-root'),
    getClawDir: vi.fn((name: string) => `/tmp/test-root/claws/${name}`),
    getNamedSubrootDir: vi.fn((name: string) => `/tmp/test-root/${name}`),
    getClawConfigPath: vi.fn((name: string) => `/tmp/test-root/claws/${name}/config.yaml`),
    resolveAgentDir: vi.fn((id: string) => id === 'motion' ? '/tmp/test-root/motion' : `/tmp/test-root/claws/${id}`),
  };
});
vi.mock('../../src/assembly/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(() => ({})),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(() => ({})),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
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
  vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (!mockState.processHandlers[event]) mockState.processHandlers[event] = [];
    mockState.processHandlers[event].push(handler);
    mockProcessOnEvent.emit('register', event);          // NEW (phase 790)
    return process;
  });

  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
    throw new ProcessExitError(typeof code === 'number' ? code : undefined);
  });

  // 保护 mockStartDaemonLoop 不受 restoreAllMocks 影响（vi.fn mockRestore 会还原为 hoisted 原始实现）
  mockState.mockStartDaemonLoop.mockImplementation((options: any) => {
    let resolve: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    mockState.stopFn = () => resolve();
    mockStartDaemonLoopCallEvent.emit('call', options);
    return { promise, stop: mockState.stopFn };
  });

  // NEW (phase 790): mockAuditWrite emit 副 channel
  mockState.mockAuditWrite.mockImplementation((firstArg: string, ...rest: unknown[]) => {
    mockAuditEvent.emit('write', firstArg, ...rest);
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
  await new Promise(resolve => setTimeout(resolve, LIBUV_IO_SETTLE_MS));
}

async function waitForProcessOn(event: string, timeoutMs = 10_000): Promise<Function> {
  const existing = mockState.processHandlers[event]?.[0];
  if (existing) return existing;
  return new Promise<Function>((resolve, reject) => {
    const timer = setTimeout(() => {
      mockProcessOnEvent.off('register', onRegister);
      reject(new Error(`waitForProcessOn timeout: ${event}`));
    }, timeoutMs);
    const onRegister = (registeredEvent: string) => {
      if (registeredEvent === event) {
        clearTimeout(timer);
        mockProcessOnEvent.off('register', onRegister);
        resolve(mockState.processHandlers[event][0]);
      }
    };
    mockProcessOnEvent.on('register', onRegister);
  });
}

async function waitForAuditCall(eventName: string, timeoutMs = 15_000): Promise<readonly unknown[]> {
  const existing = mockState.mockAuditWrite.mock.calls.find((c: unknown[]) => c[0] === eventName);
  if (existing) return existing;
  return new Promise<readonly unknown[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      mockAuditEvent.off('write', onWrite);
      reject(new Error(`waitForAuditCall timeout: ${eventName}`));
    }, timeoutMs);
    const onWrite = (firstArg: string, ...rest: unknown[]) => {
      if (firstArg === eventName) {
        clearTimeout(timer);
        mockAuditEvent.off('write', onWrite);
        resolve([firstArg, ...rest]);
      }
    };
    mockAuditEvent.on('write', onWrite);
  });
}

// ============================================================================
// Tests
// ============================================================================
import { createDaemonCommand, _resetDaemonSignalHandlers } from '../../src/daemon/daemon.js';

const daemonCommand = createDaemonCommand({
  fsFactory,
  configDefaults: {} as any,
  assemble: mockState.mockAssemble,
  disassemble: mockState.mockDisassemble,
  // phase 521 (review-round4 CLI M): motion 分支 watchdogAliveProbe! 改 explicit guard、
  // test 需明示提供 probe（或 stub）以避开 motion 分支 throw
  watchdogAliveProbe: () => true,
  auditEvents: {
    assembleFailed: 'assemble_failed',
    daemonStart: 'daemon_start',
    daemonCrash: 'daemon_crash',
  },
});

describe('daemonCommand - A4a startup success', () => {
  beforeEach(() => {
    _resetDaemonSignalHandlers();  // phase 251: clear module-level sigtermHandler/sigintHandler/uncaughtHandler/unhandledRejectionHandler refs so test #N's installation isn't seeing test #N-1's stale handler closure
    mockProcessOnEvent.removeAllListeners();
    mockAuditEvent.removeAllListeners();
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
    await cmdPromise.catch(() => { /* silent: expected-failure */ });  // 忽略 process.exit 抛错（若有）

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
    await cmdPromise.catch(() => { /* silent: expected-failure */ });

    // 断言：motion 身份分支
    expect(mockState.mockAssemble).toHaveBeenCalledWith(expect.objectContaining({
      identity: 'motion',
    }));

    // phase411: onInboxMessages 已移除（review_request 由 ContractSystem.contract_completed 事件驱动）
    expect(mockState.mockStartDaemonLoop).toHaveBeenCalledWith(expect.objectContaining({
      label: '[motion daemon]',
      motion: expect.objectContaining({ heartbeat: expect.anything() }),
    }));
  });
});


describe('daemonCommand - A4a startup failure', () => {
  beforeEach(() => {
    _resetDaemonSignalHandlers();  // phase 251: clear module-level sigtermHandler/sigintHandler/uncaughtHandler/unhandledRejectionHandler refs so test #N's installation isn't seeing test #N-1's stale handler closure
    mockProcessOnEvent.removeAllListeners();
    mockAuditEvent.removeAllListeners();
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

  it('it #3: assemble LockConflictError → audit module=lockfile + exit 1', async () => {
    const { LockConflictError } = await import('../../src/foundation/process-manager/index.js');
    const lockErr = new LockConflictError('test-claw');
    mockState.mockAssemble.mockRejectedValue(lockErr);

    await expect(daemonCommand('test-claw')).rejects.toThrow('process.exit(1)');

    // phase189 §7.A3 清零：LockConflictError 分支补 audit
    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=lockfile',
      'phase=preconstruct',
      expect.stringMatching(/reason=.*Lock conflict/),
    );
  });

  it('it #4: assemble 其他失败 → audit module=pre_assemble + exit 1', async () => {
    mockState.mockAssemble.mockRejectedValue(new Error('mock assemble crash'));

    await expect(daemonCommand('test-claw')).rejects.toThrow('process.exit(1)');

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=pre_assemble',
      'phase=preconstruct',
      expect.stringMatching(/reason=.*mock assemble crash/),
    );
  });

  it('it #5: runtime.initialize 失败 → assemble_failed audit + exit 1', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));
    mockState.mockRuntime.initialize.mockRejectedValue(new Error('init failed'));

    await expect(daemonCommand('test-claw')).rejects.toThrow('process.exit(1)');

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'assemble_failed',
      'module=runtime',
      'phase=post_assemble_init',
      expect.stringContaining('reason=init failed'),
    );
  });

  it('it #6: snapshot.commit uncategorized → snapshot_commit_uncategorized audit', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));
    mockState.mockSnapshotCommit.mockResolvedValue({
      ok: false,
      error: { kind: 'uncategorized', exitCode: 128, stderr: 'test-stderr' },
    });

    const cmdPromise = daemonCommand('test-claw');
    await waitForAuditCall('snapshot_commit_uncategorized');
    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => { /* silent: expected-failure */ });

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
    await waitForAuditCall('snapshot_commit_failed');
    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => { /* silent: expected-failure */ });

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'snapshot_commit_failed',
      'context=daemon-start',
      expect.stringContaining('reason=git not found'),
    );
  });
});


describe('daemonCommand - A4d shutdown signal', () => {
  beforeEach(() => {
    _resetDaemonSignalHandlers();  // phase 251: clear module-level sigtermHandler/sigintHandler/uncaughtHandler/unhandledRejectionHandler refs so test #N's installation isn't seeing test #N-1's stale handler closure
    mockProcessOnEvent.removeAllListeners();
    mockAuditEvent.removeAllListeners();
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
    const sigtermHandler = await waitForProcessOn('SIGTERM');

    await expect(async () => {
      await sigtermHandler!();
    }).rejects.toThrow('process.exit(0)');

    expect(mockState.mockDisassemble).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: mockState.mockRuntime }),
      'SIGTERM',
    );
    expect(selfRemovePidSpy).toHaveBeenCalledWith(expect.stringContaining('test-claw'));
    selfRemovePidSpy.mockRestore();

    await cmdPromise.catch(() => { /* silent: expected-failure */ });
  });

  it('it #9: SIGINT → shutdown → disassemble + exit 0', async () => {
    const cmdPromise = daemonCommand('test-claw');
    const sigintHandler = await waitForProcessOn('SIGINT');

    await expect(async () => {
      await sigintHandler!();
    }).rejects.toThrow('process.exit(0)');

    expect(mockState.mockDisassemble).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: mockState.mockRuntime }),
      'SIGINT',
    );

    await cmdPromise.catch(() => { /* silent: expected-failure */ });
  });
});


describe('daemonCommand - A4d crash handler', () => {
  beforeEach(() => {
    _resetDaemonSignalHandlers();  // phase 251: clear module-level sigtermHandler/sigintHandler/uncaughtHandler/unhandledRejectionHandler refs so test #N's installation isn't seeing test #N-1's stale handler closure
    mockProcessOnEvent.removeAllListeners();
    mockAuditEvent.removeAllListeners();
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
    const handler = await waitForProcessOn('uncaughtException');

    const testErr = new Error('test uncaught');
    testErr.stack = 'mock-stack';

    // phase 517 B2: handler 现在异步走 gracefulShutdown → .finally(process.exit)
    // process.exit mocked-throws、最终 rejected promise
    await expect(handler!(testErr)).rejects.toThrow('process.exit(1)');

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'daemon_crash',
      expect.stringMatching(/^error=test uncaught\nmock-stack/),
    );

    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => { /* silent: expected-failure */ });
  });

  it('it #11: unhandledRejection → daemon_crash audit + exit 1', async () => {
    const cmdPromise = daemonCommand('test-claw');
    const handler = await waitForProcessOn('unhandledRejection');

    // phase 517 B2: 同 #10 — 异步 graceful shutdown 后 process.exit
    await expect(handler!('reject reason string')).rejects.toThrow('process.exit(1)');

    expect(mockState.mockAuditWrite).toHaveBeenCalledWith(
      'daemon_crash',
      'error=reject reason string',
    );

    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => { /* silent: expected-failure */ });
  });
});


describe('daemonCommand - review_request dispatch (phase184)', () => {
  beforeEach(() => {
    _resetDaemonSignalHandlers();  // phase 251: clear module-level sigtermHandler/sigintHandler/uncaughtHandler/unhandledRejectionHandler refs so test #N's installation isn't seeing test #N-1's stale handler closure
    mockProcessOnEvent.removeAllListeners();
    mockAuditEvent.removeAllListeners();
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
    await cmdPromise.catch(() => { /* silent: expected-failure */ });
  });

  it('claw 模式下 onInboxMessages 未注册（undefined）', async () => {
    mockState.mockAssemble.mockResolvedValue(makeMockInstances({ clawId: 'test-claw' }));

    const cmdPromise = daemonCommand('test-claw');

    // Guard: ensure mockStartDaemonLoop has been called before reading calls[0] (phase 779 Step D / B.flaky-2)
    await once(mockStartDaemonLoopCallEvent, 'call');

    const options = mockState.mockStartDaemonLoop.mock.calls[0][0];
    expect(options.motion?.onInboxMessages).toBeUndefined();

    if (mockState.stopFn) mockState.stopFn();
    await cmdPromise.catch(() => { /* silent: expected-failure */ });
  });
});
