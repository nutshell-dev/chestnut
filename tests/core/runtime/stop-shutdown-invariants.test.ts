/**
 * stop shutdown invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - stop-flush-barrier.test.ts
 *  - drain-inbox-metadata.test.ts
 *  - shutdown-timeout.test.ts
 *  - regime-switch-archive-fail.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from '../_runtime-test-helpers.js';
import { runLegacyBatch } from '../../helpers/legacy-process-batch.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/index.js';

describe('stop-flush-barrier', () => {
  /**
   * runtime.stop() awaits active dialog mutation operation before closing dependencies
   * (Phase 1218 Step A).
   */

  /**
   * Mock active operation settle delay (50ms): give runtime.stop a window where
   * it must wait for the active operation before llm.close.
   */
  const MOCK_OPERATION_SETTLE_MS = 50;

  describe('runtime.stop active operation barrier (Phase 1218 Step A)', () => {
    let operationResolved: boolean;
    let llmCloseCalled: boolean;

    beforeEach(() => {
      operationResolved = false;
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
          llm: {
            close: vi.fn().mockImplementation(async () => {
              llmCloseCalled = true;
            }),
          } as any,
          toolRegistry: {} as any,
          toolExecutor: {} as any,
          contractManager: { loadPaused: vi.fn().mockResolvedValue(null), close: vi.fn().mockResolvedValue(undefined) } as any,
          taskSystem: {
            shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
          } as any,
          contextInjector: {} as any,
          execContext: {} as any,
          dialogStoreFactory: vi.fn().mockReturnValue(mockDialogStore),
        },
      });

      // Inject internal fields that initialize() would normally set
      (runtime as any).taskSystem = {
        shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
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

    it('awaits active dialog operation before closing all dependencies (Phase 1218 Step D)', async () => {
      const mockDialogStore = {
        load: vi.fn().mockResolvedValue({ session: { version: 2, messages: [], toolsForLLM: [] }, source: 'empty' }),
        save: vi.fn().mockResolvedValue(undefined),
        archive: vi.fn().mockResolvedValue(undefined),
      } as unknown as DialogStore;

      const runtime = makeRuntime(mockDialogStore);
      (runtime as any).initialized = true;

      const taskSystemShutdown = vi.spyOn((runtime as any).taskSystem, 'shutdown');
      const contractClose = vi.spyOn((runtime as any).contractManager, 'close');
      const llmClose = vi.spyOn((runtime as any).llm, 'close');

      // Simulate an active operation still in flight when stop() is called.
      (runtime as any).activeDialogOperation = new Promise<void>((resolve) => {
        setTimeout(() => { operationResolved = true; resolve(); }, MOCK_OPERATION_SETTLE_MS);
      });

      await runtime.stop();

      expect(operationResolved).toBe(true);
      expect(taskSystemShutdown).toHaveBeenCalled();
      expect(contractClose).toHaveBeenCalled();
      expect(llmClose).toHaveBeenCalled();
      // Phase 1218 Step D: active operation settle → taskSystem shutdown → contract close → llm close.
      expect(taskSystemShutdown.mock.invocationCallOrder[0]).toBeLessThan(contractClose.mock.invocationCallOrder[0]);
      expect(contractClose.mock.invocationCallOrder[0]).toBeLessThan(llmClose.mock.invocationCallOrder[0]);
    });

    it('does not throw when active operation rejects (barrier is best-effort)', async () => {
      const mockDialogStore = {
        load: vi.fn().mockResolvedValue({ session: { version: 2, messages: [], toolsForLLM: [] }, source: 'empty' }),
        save: vi.fn().mockResolvedValue(undefined),
        archive: vi.fn().mockResolvedValue(undefined),
      } as unknown as DialogStore;

      const runtime = makeRuntime(mockDialogStore);
      (runtime as any).initialized = true;

      // Simulate a rejecting active operation.
      (runtime as any).activeDialogOperation = Promise.reject(new Error('disk full'));

      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(llmCloseCalled).toBe(true);
    });
  });
});

describe('drain-inbox-metadata', () => {
  describe('Runtime DrainInbox metadata (phase 436)', () => {
    let tempDir: string;
    let clawDir: string;
    const runtimesToStop: Runtime[] = [];

    function trackRuntime(r: Runtime): Runtime {
      runtimesToStop.push(r);
      return r;
    }

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTempDir();
      clawDir = path.join(tempDir, 'claws', 'test-claw');
    });

    afterEach(async () => {
      for (const r of runtimesToStop.splice(0)) {
        await r.stop().catch(() => { /* silent: shutdown */ });
      }
      await cleanupTempDir(tempDir);
    });

    function writePending(filename: string, type: string, body: string) {
      const content = `---
id: ${filename}
type: ${type}
from: motion
priority: normal
timestamp: ${new Date().toISOString()}
---

${body}
`;
      return fs.writeFile(path.join(clawDir, 'inbox', 'pending', filename), content);
    }

    it('splits inbox batch into one Message per entry with metadata', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      await writePending('uc.md', 'user_chat', 'chat from user');
      await writePending('uim.md', 'user_inbox_message', 'inbox from user');
      await writePending('hb.md', 'heartbeat', 'heartbeat body');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const count = await runLegacyBatch(runtime);
      expect(count).toBe(3);

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMessages = callArgs.messages.filter((m: { role: string }) => m.role === 'user');
      expect(userMessages.length).toBe(3);

      const chat = userMessages.find((m: { content: string }) =>
        typeof m.content === 'string' && m.content.includes('chat from user'));
      const inbox = userMessages.find((m: { content: string }) =>
        typeof m.content === 'string' && m.content.includes('inbox from user'));
      const heartbeat = userMessages.find((m: { systemSubtype?: string }) =>
        m.systemSubtype === 'heartbeat');

      expect(chat).toBeDefined();
      expect(chat.origin).toBe('user');
      expect(chat.systemSubtype).toBeUndefined();
      expect(typeof chat.addedAt).toBe('string');

      expect(inbox).toBeDefined();
      expect(inbox.origin).toBe('user');
      expect(inbox.systemSubtype).toBeUndefined();
      expect(typeof inbox.addedAt).toBe('string');

      expect(heartbeat).toBeDefined();
      expect(heartbeat.origin).toBe('system');
      expect(heartbeat.systemSubtype).toBe('heartbeat');
      expect(typeof heartbeat.addedAt).toBe('string');
    });

    it('orders injected messages by inbox priority/timestamp order', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      await writePending('a.md', 'contract_created', 'contract A');
      await writePending('b.md', 'task_result', 'task B');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runLegacyBatch(runtime);

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMessages = callArgs.messages.filter((m: { role: string }) => m.role === 'user');
      expect(userMessages.length).toBe(2);
      expect(userMessages[0].systemSubtype).toBe('contract_created');
      expect(userMessages[1].systemSubtype).toBe('task_result');
    });
  });
});

describe('shutdown-timeout', () => {
  /**
   * runtime.stop() shutdown timeout + abort path (phase 1332 N4)
   *
   * Coverage:
   * - 120s timeout allows long tasks to complete (phase 1286 100M cascade)
   * - timeout hit triggers taskSystem.abort() before llm.close
   * - TASK_SHUTDOWN_TIMEOUT_HIT audit emitted on timeout
   * - llm.close always called after shutdown (order invariant)
   */

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
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      };

      const mockDialogStore = {
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
          llm: { close: vi.fn().mockResolvedValue(undefined) } as any,
          toolRegistry: {} as any,
          toolExecutor: {} as any,
          contractManager: { loadPaused: vi.fn().mockResolvedValue(null), close: vi.fn().mockResolvedValue(undefined) } as any,
          taskSystem: {
            shutdown: deps.shutdownImpl ?? vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
            abort: deps.abortImpl ?? vi.fn(),
          } as any,
          contextInjector: {} as any,
          execContext: {} as any,
          dialogStoreFactory: vi.fn().mockReturnValue(mockDialogStore),
        },
      });

      // Inject internal fields that initialize() would normally set
      (runtime as any).taskSystem = {
        shutdown: deps.shutdownImpl ?? vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
        abort: deps.abortImpl ?? vi.fn(),
      };
      (runtime as any).llm = { close: vi.fn().mockResolvedValue(undefined) };
      (runtime as any).sessionManager = mockDialogStore;
      (runtime as any).auditWriter = auditWriter;
      // phase 324 H5: Runtime.stop 现 await contractManager.close()，测试需注入 mock
      (runtime as any).contractManager = { close: vi.fn().mockResolvedValue(undefined) };

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
      const shutdownImpl = vi.fn().mockResolvedValue({ kind: 'timed_out', pending: ['task-pending-1'], terminal: [] });

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
      const shutdownImpl = vi.fn().mockResolvedValue({ kind: 'timed_out', pending: ['task-pending-1'], terminal: [] });
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
});

describe('regime-switch-archive-fail', () => {
  /**
   * regime switch archive fail-fast (phase 1373 sub-2)
   */

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
            shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
            initialize: vi.fn().mockResolvedValue(undefined),
            startDispatch: vi.fn(),
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
        shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
      };

      mockDialogStore.archive.mockRejectedValue(new Error('disk full'));

      // Force identity hash mismatch to trigger regime switch
      (runtime as any).lastIdentityHash = 'old-hash';

      await expect(
        (runtime as any)._performRegimeSwitch('new system prompt'),
      ).rejects.toThrow('disk full');

      // phase 595: emit 顺序变为 phase + reason、test 改全 arg 匹配
      expect(mockAudit.write).toHaveBeenCalledWith(
        DIALOG_AUDIT_EVENTS.REGIME_SWITCH_HARD_FAIL,
        'phase=archive',
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
        shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
      };
      (runtime as any).lastIdentityHash = 'old-hash';

      mockDialogStore.archive.mockResolvedValue(undefined);

      await (runtime as any)._performRegimeSwitch('new system prompt');

      const hardFailCalls = (mockAudit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: any) => c[0] === DIALOG_AUDIT_EVENTS.REGIME_SWITCH_HARD_FAIL,
      );
      expect(hardFailCalls).toHaveLength(0);
    });
  });
});
