/**
 * runtime.stop() awaits pending dialogStore.save() flush (phase 1024 G.3)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { makeAudit } from '../../helpers/audit.js';

describe('runtime.stop flush barrier (phase 1024 G.3)', () => {
  let flushResolved: boolean;
  let llmCloseCalled: boolean;

  beforeEach(() => {
    flushResolved = false;
    llmCloseCalled = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRuntime(mockDialogStore: DialogStore): Runtime {
    const { audit } = makeAudit();
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      llmConfig: {} as any,
      idleTimeoutMs: 0,
      dependencies: {
        systemFs: {} as any,
        auditWriter: audit,
        snapshot: { commit: vi.fn().mockResolvedValue({ ok: true }) } as any,
        sessionManager: mockDialogStore,
        inboxReader: {} as any,
        outboxWriter: {} as any,
        llm: {
          close: vi.fn().mockImplementation(async () => {
            llmCloseCalled = true;
          }),
        } as any,
        toolRegistry: {} as any,
        toolExecutor: {} as any,
        contractManager: { loadPaused: vi.fn().mockResolvedValue(null) } as any,
        taskSystem: {
          shutdown: vi.fn().mockResolvedValue(undefined),
        } as any,
        contextInjector: {} as any,
        execContext: {} as any,
        dialogStoreFactory: vi.fn().mockReturnValue(mockDialogStore),
      },
    });

    // Inject internal fields that initialize() would normally set
    (runtime as any).taskSystem = {
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    (runtime as any).llm = {
      close: vi.fn().mockImplementation(async () => {
        llmCloseCalled = true;
      }),
    };
    (runtime as any).sessionManager = mockDialogStore;

    return runtime;
  }

  it('awaits pending dialogStore.save before llm.close', async () => {
    const mockDialogStore = {
      getFlushPromise: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          setTimeout(() => { flushResolved = true; resolve(); }, 50);
        }),
      ),
      load: vi.fn().mockResolvedValue({ session: { version: 2, messages: [], toolsForLLM: [] }, source: 'empty' }),
      save: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
    } as unknown as DialogStore;

    const runtime = makeRuntime(mockDialogStore);

    await runtime.stop();

    expect(flushResolved).toBe(true);
    expect(llmCloseCalled).toBe(true);
    expect(mockDialogStore.getFlushPromise).toHaveBeenCalled();
  });

  it('does not throw when getFlushPromise rejects (barrier is best-effort)', async () => {
    const mockDialogStore = {
      getFlushPromise: vi.fn().mockRejectedValue(new Error('disk full')),
      load: vi.fn().mockResolvedValue({ session: { version: 2, messages: [], toolsForLLM: [] }, source: 'empty' }),
      save: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
    } as unknown as DialogStore;

    const runtime = makeRuntime(mockDialogStore);

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(mockDialogStore.getFlushPromise).toHaveBeenCalled();
  });
});
