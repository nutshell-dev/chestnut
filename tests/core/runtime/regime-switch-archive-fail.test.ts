/**
 * regime switch archive fail-fast (phase 1373 sub-2)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { makeMockAudit } from '../../helpers/audit.js';

describe('regime switch archive hard fail (phase 1373 sub-2)', () => {
  let mockDialogStore: DialogStore;
  let mockAudit: ReturnType<typeof makeMockAudit>;

  beforeEach(() => {
    mockAudit = makeMockAudit();
    mockDialogStore = {
      load: vi.fn().mockResolvedValue({
        session: {
          version: 2,
          messages: [{ role: 'user', content: 'hi' }],
          toolsForLLM: [],
        },
        source: 'current',
      }),
      save: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      getFlushPromise: vi.fn().mockResolvedValue(undefined),
      beginTurn: vi.fn().mockResolvedValue(undefined),
      commitTurn: vi.fn().mockResolvedValue(undefined),
      rollbackTurn: vi.fn().mockResolvedValue(undefined),
    } as unknown as DialogStore;
  });

  function makeRuntime(): Runtime {
    return new Runtime({
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      llmConfig: {} as any,
      idleTimeoutMs: 0,
      dependencies: {
        systemFs: {} as any,
        auditWriter: mockAudit,
        snapshot: { commit: vi.fn().mockResolvedValue({ ok: true }) } as any,
        sessionManager: mockDialogStore,
        inboxReader: {} as any,
        outboxWriter: {} as any,
        llm: { close: vi.fn().mockResolvedValue(undefined) } as any,
        toolRegistry: {
          formatForLLM: vi.fn().mockReturnValue([]),
          getForProfile: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([]),
          register: vi.fn(),
        } as any,
        toolExecutor: {} as any,
        contractManager: { loadPaused: vi.fn().mockResolvedValue(null) } as any,
        taskSystem: {
          shutdown: vi.fn().mockResolvedValue(undefined),
          initialize: vi.fn().mockResolvedValue(undefined),
          startDispatch: vi.fn(),
          setParentStreamLog: vi.fn(),
        } as any,
        contextInjector: {
          buildSystemPrompt: vi.fn().mockResolvedValue(''),
          buildSystemPromptForRegime: vi.fn().mockResolvedValue({ full: '', identityContent: 'hash-a' }),
        } as any,
        execContext: {} as any,
        dialogStoreFactory: vi.fn().mockReturnValue(mockDialogStore),
      },
    });
  }

  it('archive throw 时应 audit REGIME_SWITCH_HARD_FAIL 并 throw upstream', async () => {
    const runtime = makeRuntime();
    // Inject internal fields so _checkRegimeSwitch can run
    (runtime as any).initialized = true;
    (runtime as any).sessionManager = mockDialogStore;
    (runtime as any).toolRegistry = (runtime as any).options.dependencies.toolRegistry;
    (runtime as any).llm = { close: vi.fn().mockResolvedValue(undefined) };
    (runtime as any).taskSystem = {
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    mockDialogStore.archive.mockRejectedValue(new Error('disk full'));

    // Force identity hash mismatch to trigger regime switch
    (runtime as any).lastIdentityHash = 'old-hash';

    await expect(
      (runtime as any)._performRegimeSwitch('new system prompt'),
    ).rejects.toThrow('disk full');

    expect(mockAudit.write).toHaveBeenCalledWith(
      'regime_switch_hard_fail',
      expect.stringContaining('disk full'),
    );
  });

  it('archive 成功后不应 audit REGIME_SWITCH_HARD_FAIL', async () => {
    const runtime = makeRuntime();
    (runtime as any).initialized = true;
    (runtime as any).sessionManager = mockDialogStore;
    (runtime as any).toolRegistry = (runtime as any).options.dependencies.toolRegistry;
    (runtime as any).llm = { close: vi.fn().mockResolvedValue(undefined) };
    (runtime as any).taskSystem = {
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    (runtime as any).lastIdentityHash = 'old-hash';

    mockDialogStore.archive.mockResolvedValue(undefined);

    await (runtime as any)._performRegimeSwitch('new system prompt');

    const hardFailCalls = (mockAudit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any) => c[0] === 'regime_switch_hard_fail',
    );
    expect(hardFailCalls).toHaveLength(0);
  });
});
