/**
 * runtime.stop() shutdown timeout + abort path (phase 1332 N4)
 *
 * Coverage:
 * - 120s timeout allows long tasks to complete (phase 1286 100M cascade)
 * - timeout hit triggers taskSystem.abort() before llm.close
 * - TASK_SHUTDOWN_TIMEOUT_HIT audit emitted on timeout
 * - llm.close always called after shutdown (order invariant)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';

describe('runtime.stop shutdown timeout (phase 1332 N4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeRuntime(deps: {
    shutdownImpl?: () => Promise<void>;
    abortImpl?: () => void;
  } = {}): { runtime: Runtime; auditEvents: Array<{ type: string; args: string[] }> } {
    const auditEvents: Array<{ type: string; args: string[] }> = [];
    const auditWriter = {
      write: (type: string, ...args: string[]) => {
        auditEvents.push({ type, args });
      },
    };

    const mockDialogStore = {
      getFlushPromise: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue({ session: { version: 2, messages: [], toolsForLLM: [] }, source: 'empty' }),
      save: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
    } as unknown as DialogStore;

    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      llmConfig: {} as any,
      idleTimeoutMs: 0,
      dependencies: {
        systemFs: {} as any,
        auditWriter: auditWriter as any,
        snapshot: { commit: vi.fn().mockResolvedValue({ ok: true }) } as any,
        sessionManager: mockDialogStore,
        inboxReader: {} as any,
        outboxWriter: {} as any,
        llm: { close: vi.fn().mockResolvedValue(undefined) } as any,
        toolRegistry: {} as any,
        toolExecutor: {} as any,
        contractManager: { loadPaused: vi.fn().mockResolvedValue(null) } as any,
        taskSystem: {
          shutdown: deps.shutdownImpl ?? vi.fn().mockResolvedValue(undefined),
          abort: deps.abortImpl ?? vi.fn(),
        } as any,
        contextInjector: {} as any,
        execContext: {} as any,
        dialogStoreFactory: vi.fn().mockReturnValue(mockDialogStore),
      },
    });

    // Inject internal fields that initialize() would normally set
    (runtime as any).taskSystem = {
      shutdown: deps.shutdownImpl ?? vi.fn().mockResolvedValue(undefined),
      abort: deps.abortImpl ?? vi.fn(),
    };
    (runtime as any).llm = { close: vi.fn().mockResolvedValue(undefined) };
    (runtime as any).sessionManager = mockDialogStore;
    (runtime as any).auditWriter = auditWriter;

    return { runtime, auditEvents };
  }

  it('shutdown 120s timeout — normal completion does not abort', async () => {
    const { runtime } = makeRuntime();

    await runtime.stop();

    const taskSystem = (runtime as any).taskSystem;
    expect(taskSystem.shutdown).toHaveBeenCalledWith(120_000);
    expect(taskSystem.abort).not.toHaveBeenCalled();
    expect((runtime as any).llm.close).toHaveBeenCalled();
  });

  it('shutdown timeout hit — abort path + TASK_SHUTDOWN_TIMEOUT_HIT audit', async () => {
    const abortImpl = vi.fn();
    const shutdownImpl = vi.fn().mockResolvedValue(true);

    const { runtime, auditEvents } = makeRuntime({ shutdownImpl, abortImpl });

    await runtime.stop();

    expect(shutdownImpl).toHaveBeenCalledWith(120_000);
    expect(abortImpl).toHaveBeenCalled();
    expect(auditEvents).toContainEqual({
      type: TASK_AUDIT_EVENTS.TASK_SHUTDOWN_TIMEOUT_HIT,
      args: expect.arrayContaining([expect.stringContaining('timeout_ms=120000')]),
    });
    expect((runtime as any).llm.close).toHaveBeenCalled();
  });

  it('llm.close is called after shutdown even when timeout occurs', async () => {
    const shutdownImpl = vi.fn().mockResolvedValue(true);
    const { runtime } = makeRuntime({ shutdownImpl });

    await runtime.stop();

    const taskSystem = (runtime as any).taskSystem;
    const llmClose = (runtime as any).llm.close;

    const shutdownCallOrder = taskSystem.shutdown.mock.invocationCallOrder[0];
    const llmCloseCallOrder = llmClose.mock.invocationCallOrder[0];
    expect(llmCloseCallOrder).toBeGreaterThan(shutdownCallOrder);
    expect(llmClose).toHaveBeenCalled();
  });
});
