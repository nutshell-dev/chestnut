/**
 * runtime.stop() awaits pending dialogStore.save() flush (phase 1024 G.3)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { makeAudit } from '../../helpers/audit.js';

/**
 * Mock pending flush 完成延迟 (50ms): 等 runtime.stop 调用 getFlushPromise 后 settle.
 * Derivation: > microtask flush / 给 stop barrier 真等 flush settle 的窗口.
 */
const MOCK_FLUSH_SETTLE_MS = 50;

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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
        contractManager: { loadPaused: vi.fn().mockResolvedValue(null), close: vi.fn().mockResolvedValue(undefined) } as any,
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
    // phase 324 H5: Runtime.stop 现 await contractManager.close()，测试需注入 mock
    (runtime as any).contractManager = { close: vi.fn().mockResolvedValue(undefined) };

    return runtime;
  }

  it('awaits pending dialogStore.save before llm.close', async () => {
    const mockDialogStore = {
      getFlushPromise: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          setTimeout(() => { flushResolved = true; resolve(); }, MOCK_FLUSH_SETTLE_MS);
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
