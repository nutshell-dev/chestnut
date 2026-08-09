/**
 * DialogStore mutation authority — Runtime single active operation guard
 * Phase 1218 Step A
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { StreamCallbacks, TurnResult } from '../../../src/core/runtime/types.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { makeAudit } from '../../helpers/audit.js';

const MOCK_OPERATION_SETTLE_MS = 50;

class AuthorityTestRuntime extends Runtime {
  public turnRelease: (() => void) | undefined;
  public turnStarted = false;
  public turnShouldReject: Error | undefined;

  public proactiveRelease: (() => void) | undefined;
  public proactiveStarted = false;
  public proactiveShouldBlock = false;

  protected override async _processTurnImpl(
    _messages: Message[],
    _systemPrompt: string,
    _toolsForLLM: ToolDefinition[],
    _callbacks?: StreamCallbacks,
    _reuseTraceId?: string,
  ): Promise<TurnResult> {
    this.turnStarted = true;
    if (this.turnShouldReject) {
      throw this.turnShouldReject;
    }
    await new Promise<void>((resolve) => {
      this.turnRelease = resolve;
    });
    return { status: 'success' };
  }

  protected override async _proactiveTrimIfNeededImpl(
    messages: Message[],
    _systemPrompt: string,
    _toolsForLLM: ToolDefinition[],
  ): Promise<Message[]> {
    if (this.proactiveShouldBlock) {
      this.proactiveStarted = true;
      await new Promise<void>((resolve) => {
        this.proactiveRelease = resolve;
      });
    }
    return messages;
  }
}

function makeMockDialogStore(): DialogStore {
  return {
    load: vi.fn().mockResolvedValue({
      session: {
        version: 2,
        messages: [{ role: 'user', content: 'hi' }],
        toolsForLLM: [],
        systemPrompt: 'sp',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      source: 'current',
    }),
    save: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    beginTurn: vi.fn().mockResolvedValue(undefined),
    commitTurn: vi.fn().mockResolvedValue(undefined),
    rollbackTurn: vi.fn().mockResolvedValue(undefined),
  } as unknown as DialogStore;
}

function makeRuntime(mockDialogStore: DialogStore): { runtime: AuthorityTestRuntime; auditEvents: string[][] } {
  const { audit, events } = makeAudit();
  const runtime = new AuthorityTestRuntime({
    clawId: 'test-claw',
    clawDir: '/tmp/test',
    llmConfig: { primary: { model: 'test' } } as any,
    idleTimeoutMs: 0,
    dependencies: {
      systemFs: {} as any,
      auditWriter: audit,
      snapshot: { commit: vi.fn().mockResolvedValue({ ok: true }) } as any,
      sessionManager: mockDialogStore,
      inboxReader: {} as any,
      llm: {
        close: vi.fn().mockResolvedValue(undefined),
        resetLastSuccessProvider: vi.fn(),
        getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
      } as any,
      toolRegistry: {
        formatForLLM: vi.fn().mockReturnValue([]),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
      } as any,
      toolExecutor: {} as any,
      contractManager: { loadPaused: vi.fn().mockResolvedValue(null), close: vi.fn().mockResolvedValue(undefined) } as any,
      taskSystem: {
        shutdown: vi.fn().mockResolvedValue(undefined),
        initialize: vi.fn().mockResolvedValue(undefined),
        startDispatch: vi.fn(),
      } as any,
      skillRegistry: {} as any,
      permissionChecker: {} as any,
      fsFactory: () => ({}) as any,
      contextInjector: {
        buildSystemPrompt: vi.fn().mockResolvedValue(''),
        buildSystemPromptForRegime: vi.fn().mockResolvedValue({ full: '', identityContent: 'hash-a' }),
      } as any,
      execContext: {} as any,
      dialogStoreFactory: vi.fn().mockReturnValue(mockDialogStore),
      formatterRegistry: { resolve: vi.fn().mockReturnValue(null), register: vi.fn() } as any,
      clawSubdirs: [],
    },
  });

  // Inject internal fields that initialize() would normally set
  (runtime as any).initialized = true;
  (runtime as any).taskSystem = {
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  (runtime as any).llm = {
    close: vi.fn().mockResolvedValue(undefined),
    resetLastSuccessProvider: vi.fn(),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  };
  (runtime as any).sessionManager = mockDialogStore;
  (runtime as any).contractManager = { close: vi.fn().mockResolvedValue(undefined) };
  (runtime as any).execContext = {};
  (runtime as any).auditWriter = audit;

  return { runtime, auditEvents: events };
}

describe('Runtime dialog mutation authority (Phase 1218 Step A)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stop awaits active turn operation before closing dependencies', async () => {
    const { runtime } = makeRuntime(makeMockDialogStore());

    const turnPromise = runtime.processTurn([], 'sp', []);
    await vi.waitUntil(() => runtime.turnStarted, { timeout: 1000 });

    let closed = false;
    const llmClose = vi.spyOn((runtime as any).llm, 'close').mockImplementation(async () => {
      closed = true;
    });

    const stopPromise = runtime.stop();

    // Give stop() a chance to proceed past taskSystem.shutdown to the join barrier.
    await vi.advanceTimersByTimeAsync(10);
    expect(closed).toBe(false);

    runtime.turnRelease!();
    await Promise.all([turnPromise, stopPromise]);

    expect(closed).toBe(true);
    expect(llmClose).toHaveBeenCalled();
  });

  it('stopping rejects new public operations with audit', async () => {
    const { runtime, auditEvents } = makeRuntime(makeMockDialogStore());

    runtime.stop();

    await expect(runtime.processTurn([], 'sp', [])).rejects.toThrow('Runtime is stopping');

    expect(auditEvents.some((e) => e[0] === RUNTIME_AUDIT_EVENTS.DIALOG_OPERATION_WHILE_STOPPING)).toBe(true);
  });

  it('concurrent public operations fail-fast on second acquire', async () => {
    const { runtime, auditEvents } = makeRuntime(makeMockDialogStore());

    const first = runtime.processTurn([], 'sp', []);
    await vi.waitUntil(() => runtime.turnStarted, { timeout: 1000 });

    await expect(runtime.processTurn([], 'sp', [])).rejects.toThrow('Concurrent dialog operation detected');

    expect(auditEvents.some((e) => e[0] === RUNTIME_AUDIT_EVENTS.DIALOG_OPERATION_CONCURRENT)).toBe(true);

    runtime.turnRelease!();
    await first;
  });

  it('operation rejection clears handle and preserves original error', async () => {
    const { runtime } = makeRuntime(makeMockDialogStore());
    const originalError = new Error('turn crashed');
    runtime.turnShouldReject = originalError;

    await expect(runtime.processTurn([], 'sp', [])).rejects.toThrow(originalError);

    expect((runtime as any).activeDialogOperation).toBeNull();
  });

  it('reactiveTrim is an independent public mutation operation', async () => {
    const { runtime, auditEvents } = makeRuntime(makeMockDialogStore());

    const first = runtime.processTurn([], 'sp', []);
    await vi.waitUntil(() => runtime.turnStarted, { timeout: 1000 });

    await expect(runtime.reactiveTrim()).rejects.toThrow('Concurrent dialog operation detected');

    expect(auditEvents.some((e) => e[0] === RUNTIME_AUDIT_EVENTS.DIALOG_OPERATION_CONCURRENT)).toBe(true);

    runtime.turnRelease!();
    await first;
  });

  it('proactiveTrimIfNeeded is a public mutation operation (Phase 1218 Step D)', async () => {
    const { runtime, auditEvents } = makeRuntime(makeMockDialogStore());
    runtime.proactiveShouldBlock = true;

    const first = runtime.proactiveTrimIfNeeded([], 'sp', []);
    await vi.waitUntil(() => runtime.proactiveStarted, { timeout: 1000 });

    await expect(runtime.processTurn([], 'sp', [])).rejects.toThrow('Concurrent dialog operation detected');

    expect(auditEvents.some((e) => e[0] === RUNTIME_AUDIT_EVENTS.DIALOG_OPERATION_CONCURRENT)).toBe(true);

    runtime.proactiveRelease!();
    await first;
  });

  it('stopping rejects proactiveTrimIfNeeded with audit (Phase 1218 Step D)', async () => {
    const { runtime, auditEvents } = makeRuntime(makeMockDialogStore());

    runtime.stop();

    await expect(runtime.proactiveTrimIfNeeded([], 'sp', [])).rejects.toThrow('Runtime is stopping');

    expect(auditEvents.some((e) => e[0] === RUNTIME_AUDIT_EVENTS.DIALOG_OPERATION_WHILE_STOPPING)).toBe(true);
  });

  it('stop awaits active proactive trim before shutting down dependencies (Phase 1218 Step D)', async () => {
    const { runtime } = makeRuntime(makeMockDialogStore());
    runtime.proactiveShouldBlock = true;

    const taskSystemShutdown = vi.spyOn((runtime as any).taskSystem, 'shutdown');
    const contractClose = vi.spyOn((runtime as any).contractManager, 'close');
    const llmClose = vi.spyOn((runtime as any).llm, 'close');

    const trimPromise = runtime.proactiveTrimIfNeeded([], 'sp', []);
    await vi.waitUntil(() => runtime.proactiveStarted, { timeout: 1000 });

    const stopPromise = runtime.stop();

    // Give stop() a chance to proceed; dependencies must remain open while the
    // active dialog mutation operation is in flight.
    await vi.advanceTimersByTimeAsync(10);
    expect(taskSystemShutdown).not.toHaveBeenCalled();
    expect(contractClose).not.toHaveBeenCalled();
    expect(llmClose).not.toHaveBeenCalled();

    runtime.proactiveRelease!();
    await Promise.all([trimPromise, stopPromise]);

    expect(taskSystemShutdown).toHaveBeenCalled();
    expect(contractClose).toHaveBeenCalled();
    expect(llmClose).toHaveBeenCalled();
  });
});
