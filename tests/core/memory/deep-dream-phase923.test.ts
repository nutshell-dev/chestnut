/**
 * Phase 923 — deep-dream success marking + failure break + output-before-state ordering.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  __test_processSession,
  __test_persistDreamRun,
  type __test_DreamRunContext,
  type __test_DreamRunPlan,
  type __test_SessionFile,
  type __test_ProcessResult,
} from '../../../src/core/memory/deep-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { CURRENT_DIALOG_FILE } from '../../../src/foundation/dialog-store/index.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';

describe('deep-dream phase 923 invariants', () => {
  function makeCtx(overrides?: Partial<__test_DreamRunContext>): __test_DreamRunContext {
    return {
      clawId: 'test-claw',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawDir: '/tmp/claw',
      clawFs: {} as unknown as FileSystem,
      motionFs: undefined,
      llm: {
        call: vi.fn(),
        stream: vi.fn(),
        healthCheck: vi.fn(),
        getProviderInfo: vi.fn(),
        close: vi.fn(),
      } as unknown as LLMOrchestrator,
      maxCompressionTokens: 100,
      audit: makeMockAudit(),
      ...overrides,
    };
  }

  function makePlan(overrides?: Partial<__test_DreamRunPlan>): __test_DreamRunPlan {
    return {
      state: {
        lastProcessedDeepDreamAt: 1000,
        currentSessionDreamedDate: '',
        currentSessionRetryCount: 0,
      },
      dialogStore: {
        load: vi.fn(),
        readArchive: vi.fn(),
      } as unknown as DialogStore,
      sessionFiles: [],
      today: '2026-07-12',
      ...overrides,
    };
  }

  function makeSessionFile(filename: string, tsMs: number): __test_SessionFile {
    return { filename, tsMs };
  }

  describe('LLM failure on current.json', () => {
    it('does not mark current as dreamed and increments retry count', async () => {
      const ctx = makeCtx();
      const plan = makePlan();
      const sf = makeSessionFile(CURRENT_DIALOG_FILE, 2000);

      (plan.dialogStore.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        source: 'current',
        session: { messages: [{ role: 'user', content: 'hello' }] },
      });
      (ctx.llm.call as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM unreachable'));

      const result = await __test_processSession(ctx, sf, plan, [], []);

      expect(result).toEqual({ status: 'skip', reason: 'llm_call_failed' });
      expect(plan.state.currentSessionRetryCount).toBe(1);
      expect(plan.state.lastProcessedDeepDreamAt).toBe(1000);

      const auditCalls = (ctx.audit.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(auditCalls.some(([type]) => type === MEMORY_AUDIT_EVENTS.DEEP_DREAM_CALL_FAILED)).toBe(true);

      // persistDreamRun with currentProcessed=false must keep currentSessionDreamedDate unchanged.
      const writeAtomicSync = vi.fn();
      const clawFs = { writeAtomicSync } as unknown as FileSystem;
      const persistCtx = makeCtx({ clawFs });
      await __test_persistDreamRun(persistCtx, plan, [], false);
      expect(writeAtomicSync).toHaveBeenCalledTimes(1);
      const savedState = JSON.parse(writeAtomicSync.mock.calls[0][1]);
      expect(savedState.currentSessionDreamedDate).toBe('');
      expect(savedState.currentSessionRetryCount).toBe(1);
    });
  });

  describe('failure breaks processing loop', () => {
    it('stops after first failure and does not advance waterline past it', async () => {
      const ctx = makeCtx();
      const plan = makePlan();
      const files = [
        makeSessionFile('2000_archive.json', 2000),
        makeSessionFile('3000_archive.json', 3000),
        makeSessionFile('4000_archive.json', 4000),
      ];

      (plan.dialogStore.readArchive as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
        return { messages: [{ role: 'user', content: `content of ${name}` }] };
      });

      const llmCall = ctx.llm.call as ReturnType<typeof vi.fn>;
      llmCall.mockRejectedValueOnce(new Error('LLM failed on A'));
      llmCall.mockResolvedValue({ content: [{ type: 'text', text: 'compressed' }] });

      const results: __test_ProcessResult[] = [];
      let compressions: string[] = [];
      const dreamOutputs: string[] = [];
      let currentProcessed = false;

      // Replicate runDeepDreamForClaw loop logic to verify break behavior.
      for (const sf of files) {
        const result = await __test_processSession(ctx, sf, plan, compressions, dreamOutputs);
        results.push(result);
        if (result.status === 'skip') break;
        compressions = result.compressions;
        if (sf.filename === CURRENT_DIALOG_FILE) currentProcessed = true;
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ status: 'skip', reason: 'llm_call_failed' });
      // Only file A was read.
      expect(plan.dialogStore.readArchive).toHaveBeenCalledTimes(1);
      expect(plan.dialogStore.readArchive).toHaveBeenCalledWith('2000_archive.json');
      // Waterline must not advance past the failed file.
      expect(plan.state.lastProcessedDeepDreamAt).toBe(1000);
      expect(currentProcessed).toBe(false);
    });
  });

  describe('output write failure prevents state commit', () => {
    it('does not call saveDreamState when writeAtomic rejects', async () => {
      const writeAtomicSync = vi.fn();
      const clawFs = { writeAtomicSync } as unknown as FileSystem;
      const motionFs = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockRejectedValue(new Error('ENOSPC')),
      } as unknown as FileSystem;

      const ctx = makeCtx({ clawFs, motionFs });
      const plan = makePlan({
        state: {
          lastProcessedDeepDreamAt: 5000,
          currentSessionDreamedDate: '2026-07-11',
          currentSessionRetryCount: 2,
        },
      });

      await expect(
        __test_persistDreamRun(ctx, plan, ['output line 1', 'output line 2'], true),
      ).rejects.toThrow('ENOSPC');

      // State save must not have happened because writeAtomic threw first.
      expect(writeAtomicSync).not.toHaveBeenCalled();
      // Original state values unchanged.
      expect(plan.state.lastProcessedDeepDreamAt).toBe(5000);
      expect(plan.state.currentSessionDreamedDate).toBe('2026-07-11');
      expect(plan.state.currentSessionRetryCount).toBe(2);
    });
  });
});
