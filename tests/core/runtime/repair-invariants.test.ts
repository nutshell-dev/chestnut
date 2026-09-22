/**
 * repair invariants — mechanical merge of the following source files:
 *  - repair-session-load-audit.test.ts
 *  - userinterrupt-system-message-no-redrive.test.ts
 *
 * Step H (phase1895): userinterrupt-* 部分改由真实 EventLoop 单 owner 驱动
 * （替代 legacy-process-batch）。语义变迁：interrupt 不冒泡——「rejects StepAbortError」
 * 断言退役，commitTurn('user_interrupt') + ack + 0 nack 断言强度不变。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Runtime } from '../../../src/core/runtime/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../../src/foundation/audit/writer.js';
import { Snapshot } from '../../../src/foundation/snapshot/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from '../../../src/assembly/config/snapshot-patterns.js';
import { InboxReader } from '../../../src/foundation/messaging/index.js';
import { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../../src/foundation/messaging/dirs.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { initializeClawLayout } from '../../../src/assembly/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { StepAbortError } from '../../../src/core/step-executor/index.js';
import type { PreparedInboxBatch, FormattedInboxBatch } from '../../../src/core/runtime/index.js';
import type { InboxHandle } from '../../../src/foundation/messaging/types.js';
import { createMockLLMConfig as createSharedMockLLMConfig } from '../_runtime-test-helpers.js';
import { createTestEventLoop } from '../../helpers/test-event-loop.js';

// Step H (phase1895): EventLoop 驱动失败 turn 时 dispatchError fallback 有
// UNKNOWN_ERROR_RECOVERY_DELAY_MS 退避；测试用小值锁状态机。
vi.mock('../../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/event-loop/constants.js')>('../../../src/core/event-loop/constants.js');
  return {
    ...actual,
    UNKNOWN_ERROR_RECOVERY_DELAY_MS: 10,
    INTERRUPT_RECOVERY_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_MAX_DELAY_MS: 50,
  };
});

describe('repair-session-load-audit', () => {
  /**
   * Runtime — repairSessionIfNeeded load failure observability (R72-P1-2)
   *
   * Covers:
   * - sessionManager.load() failure → SESSION_REPAIR_FAILED audit with context=load_skipped
   * - initialize() does NOT throw (null fallback)
   * - turn pipeline remains reachable after load failure
   */

  describe('Runtime — repairSessionIfNeeded load failure observability (R72-P1-2)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    async function makeDeps(clawDir: string) {
      const systemFs = new NodeFileSystem({ baseDir: clawDir });
      initializeClawLayout(systemFs);
      const clawFs = new NodeFileSystem({ baseDir: clawDir });
      const auditWriter = new AuditWriter(systemFs, 'audit.tsv', null);

      const snapshot = new Snapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
      vi.spyOn(snapshot, 'init').mockResolvedValue({ ok: true } as any);
      vi.spyOn(snapshot, 'commit').mockResolvedValue({ ok: true } as any);

      const sessionManager = new DialogStore(systemFs, 'dialog', auditWriter, 'current.json', 'test-claw');
      const inboxReader = new InboxReader(INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, systemFs, auditWriter);
      return { systemFs, clawFs, auditWriter, snapshot, sessionManager, inboxReader };
    }

    function minimalMocks() {
      return {
        llm: { close: vi.fn().mockResolvedValue(undefined) } as any,
        toolRegistry: {
          register: vi.fn(),
          getForProfile: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([]),
          formatForLLM: vi.fn().mockReturnValue(''),
        } as any,
        toolExecutor: {} as any,
        contractManager: {} as any,
        taskSystem: {
          initialize: vi.fn().mockResolvedValue(undefined),
          startDispatch: vi.fn(),
          shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
        } as any,
        contextInjector: {} as any,
        execContext: {} as any,
        dialogStoreFactory: vi.fn(),
        formatterRegistry: {} as any,
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        permissionChecker: {} as any,
        skillRegistry: {} as any,
      };
    }

    it('triggers SESSION_REPAIR_FAILED audit context=load_skipped when sessionManager.load throws', async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      const clawDir = path.join(tmpdir(), `runtime-repair-load-test-${randomUUID()}`, 'claws', 'test');
      await fs.mkdir(clawDir, { recursive: true });

      const deps = await makeDeps(clawDir);
      const auditSpy = vi.spyOn(deps.auditWriter, 'write');

      // Mock sessionManager.load to throw
      const loadError = new Error('disk-full');
      vi.spyOn(deps.sessionManager, 'load').mockRejectedValue(loadError);

      const mocks = minimalMocks();
      const runtime = new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: { primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' }, maxAttempts: 1, retryDelayMs: 0 },
        dependencies: { ...deps, ...mocks } as any,
      });

      // Should NOT throw — load error is caught internally and falls back to null
      await expect(runtime.initialize()).resolves.not.toThrow();

      const sessionRepairFailedCall = auditSpy.mock.calls.find(
        (c) => c[0] === RUNTIME_AUDIT_EVENTS.SESSION_REPAIR_FAILED
      );
      expect(sessionRepairFailedCall).toBeDefined();
      expect(sessionRepairFailedCall![1]).toBe('context=load_skipped');
      expect(sessionRepairFailedCall![2]).toContain('reason=disk-full');

      // Cleanup
      await fs.rm(path.dirname(path.dirname(clawDir)), { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });
  });
});

describe('userinterrupt-system-message-no-redrive', () => {
  /**
   * phase 1415 invariant: UserInterrupt → inbox 文件一律 ack（不退回 pending）。
   *
   * Reframe phase 1403 — 不再按 isUserTypedInbox 分流。
   * 守不再退化为 phase 1403 死循环（系统通知反复注入 dialog）。
   *
   * 覆盖：
   *   - type=message（contract-new 等通用系统通知）
   *   - type=claw_crashed（legacy watchdog 历史消息，当前无 producer）
   *   - type=heartbeat（heartbeat 投递）
   *   - 混合批（user_chat + 系统）— 全 ack、0 nack
   *   - 反向：保 UserInterrupt 路径不再产生 nack（捕回归）
   */

  describe('phase 1415: UserInterrupt → system-typed inbox no-redrive invariant', () => {
    let testTempDir: string;
    let testClawDir: string;
    const runtimes: Runtime[] = [];

    beforeEach(async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      testTempDir = path.join(tmpdir(), `chestnut-1415-${randomUUID()}`);
      testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
      await fs.mkdir(testClawDir, { recursive: true });
    });

    afterEach(async () => {
      for (const r of runtimes.splice(0)) {
        await r.stop().catch(() => { /* silent: shutdown */ });
      }
      await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    /**
     * Step H: EventLoop 走 prepareInbox/formatPreparedInbox/peekPendingTurnFacts 公开面。
     * fake inbox batch 一次性消费（对齐旧 drain「领取后不再重复」语义）。
     */
    class InterruptTestRuntime extends Runtime {
      public fakeBatch: {
        injected: Message[];
        sources: Array<{ text: string; type: string }>;
        infos: InboxMessage[];
        handles: InboxHandle[];
      } | null = null;
      private preparedSnapshot: NonNullable<InterruptTestRuntime['fakeBatch']> | null = null;
      public reactThrow: Error | null = null;

      protected override async prepareInbox(): Promise<PreparedInboxBatch> {
        const batch = this.fakeBatch;
        this.fakeBatch = null;
        this.preparedSnapshot = batch;
        if (!batch) return { entries: [] };
        return {
          entries: batch.handles.map((handle, i) => ({ message: batch.infos[i], handle })),
        };
      }

      protected override async formatPreparedInbox(): Promise<FormattedInboxBatch> {
        const batch = this.preparedSnapshot;
        if (!batch) return { injected: [], sources: [], count: 0, infos: [] };
        return {
          injected: batch.injected,
          sources: batch.sources,
          count: batch.injected.length,
          infos: batch.infos,
        };
      }

      protected override async peekPendingTurnFacts(): Promise<{ addressed: InboxMessage[]; controls: InboxMessage[] }> {
        return { addressed: this.fakeBatch ? this.fakeBatch.infos : [], controls: [] };
      }

      protected override async _runReact(_messages: Message[]) {
        if (this.reactThrow) throw this.reactThrow;
      }
    }

    function makeFakeBatch(
      injected: Message[],
      infos: InboxMessage[],
      handles: InboxHandle[],
    ): NonNullable<InterruptTestRuntime['fakeBatch']> {
      return {
        injected,
        sources: [],
        infos,
        handles,
      };
    }

    async function makeInterruptRuntime() {
      const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'edge-claw' });
      const runtime = new InterruptTestRuntime({
        clawId: 'edge-claw',
        clawDir: testClawDir,
        llmConfig: createSharedMockLLMConfig(),
        dependencies: deps,
      });
      runtimes.push(runtime);
      await runtime.initialize();
      return runtime;
    }

    function makeInfo(type: InboxMessage['type'], id: string, from = 'system'): InboxMessage {
      return {
        id, type, from, to: 'edge-claw',
        content: `body for ${id}`, priority: 'high',
        timestamp: new Date().toISOString(),
      } as InboxMessage;
    }

    const systemTypedCases: Array<{ type: InboxMessage['type']; from: string; desc: string }> = [
      { type: 'message', from: 'system', desc: 'contract-new (CLI-injected via notifyContractCreated)' },
      { type: 'claw_crashed', from: 'watchdog', desc: 'legacy watchdog crash notification (no producer)' },
      { type: 'heartbeat', from: 'heartbeat', desc: 'heartbeat tick' },
    ];

    for (const c of systemTypedCases) {
      it(`UserInterrupt + system-typed (type=${c.type}, from=${c.from}, ${c.desc}): ack (no nack, no redrive)`, async () => {
        const runtime = await makeInterruptRuntime();
        const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
        const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
        const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

        runtime.fakeBatch = makeFakeBatch(
          [{ role: 'user', content: [{ type: 'text', text: c.desc }] }],
          [makeInfo(c.type, 'msg-x', c.from)],
          [{ filePath: 'inflight/msg-x.md', originalFileName: 'msg-x.md' } as InboxHandle],
        );
        runtime.reactThrow = new StepAbortError({ kind: 'user_interrupt' });

        await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

        expect(commitSpy).toHaveBeenCalledWith('user_interrupt');
        expect(ackSpy).toHaveBeenCalledTimes(1);
        expect(ackSpy).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'inflight/msg-x.md' }));
        expect(nackSpy).not.toHaveBeenCalled();
      });
    }

    it('UserInterrupt + mixed batch (3 messages: user_chat + message + claw_crashed): all ack, 0 nack', async () => {
      const runtime = await makeInterruptRuntime();
      const ackSpy = vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
      const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
      const commitSpy = vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

      runtime.fakeBatch = makeFakeBatch(
        [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'user', content: [{ type: 'text', text: 'contract done' }] },
          { role: 'user', content: [{ type: 'text', text: 'crash detected' }] },
        ],
        [
          makeInfo('user_chat', 'u1', 'user'),
          makeInfo('message', 'm2', 'auditor'),
          makeInfo('claw_crashed', 'c3', 'watchdog'),
        ],
        [
          { filePath: 'inflight/u1.md', originalFileName: 'u1.md' } as InboxHandle,
          { filePath: 'inflight/m2.md', originalFileName: 'm2.md' } as InboxHandle,
          { filePath: 'inflight/c3.md', originalFileName: 'c3.md' } as InboxHandle,
        ],
      );
      runtime.reactThrow = new StepAbortError({ kind: 'user_interrupt' });

      await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

      expect(commitSpy).toHaveBeenCalledWith('user_interrupt');
      expect(ackSpy).toHaveBeenCalledTimes(3);
      expect(nackSpy).not.toHaveBeenCalled();
    });

    it('UserInterrupt path 0 nack invariant: nack call count must be 0（守 phase 1415 不退化）', async () => {
      const runtime = await makeInterruptRuntime();
      const nackSpy = vi.spyOn((runtime as any).inboxReader, 'nack').mockResolvedValue(undefined);
      vi.spyOn((runtime as any).inboxReader, 'ack').mockResolvedValue(undefined);
      vi.spyOn((runtime as any).sessionManager, 'commitTurn').mockResolvedValue(undefined);

      runtime.fakeBatch = makeFakeBatch(
        [{ role: 'user', content: [{ type: 'text', text: 'sys' }] }],
        [makeInfo('message', 'm1', 'system')],
        [{ filePath: 'inflight/m1.md', originalFileName: 'm1.md' } as InboxHandle],
      );
      runtime.reactThrow = new StepAbortError({ kind: 'user_interrupt' });

      await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

      // 反向守：若 UserInterrupt 分支被回退到 phase 1403 形态、nack 会被调用 → 本测 fail
      expect(nackSpy).toHaveBeenCalledTimes(0);
    });
  });
});
