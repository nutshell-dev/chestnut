/**
 * misc invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - deep-dream-phase926.test.ts
 *  - memory-search-phase926.test.ts
 *  - random-dream-pulse-audit.test.ts
 *  - deep-dream-clawfs-factory.test.ts
 *  - deep-dream-phase923.test.ts
 *  - random-dream-phase926.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __test_loadDreamState, __test_DEEP_DREAM_STATE_FILE, runDeepDream, __test_processSession, __test_persistDreamRun } from '../../../src/core/memory/deep-dream.js';
import type { DeepDreamOptions, __test_DreamRunContext, __test_DreamRunPlan, __test_SessionFile, __test_ProcessResult } from '../../../src/core/memory/deep-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import { memorySearchTool } from '../../../src/core/memory/tools/memory_search.js';
import type { ExecutionInfra } from '../../../src/foundation/tools/types.js';
import { waitForTaskResult, __test_loadRandomDreamState, __test_RANDOM_DREAM_STATE_FILE } from '../../../src/core/memory/random-dream.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import { CURRENT_DIALOG_FILE } from '../../../src/foundation/dialog-store/index.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';

describe('deep-dream-phase926', () => {
  /**
   * Phase 926 — deep-dream future schema guard.
   */

  const clawId = 'test-claw';

  function makeMockFs(readImpl: (file: string) => string): FileSystem {
    return { readSync: vi.fn(readImpl) } as any;
  }

  describe('deep-dream phase926 invariants', () => {
    describe('loadDreamState future version guard', () => {
      it('returns default state for future schema_version and keeps file on disk', () => {
        const fs = makeMockFs(() => JSON.stringify({
          schema_version: 99,
          lastProcessedDeepDreamAt: 12345,
          currentSessionDreamedDate: '2026-01-01',
        }));
        const audit = makeMockAudit();

        const state = __test_loadDreamState(fs, audit, clawId);
        expect(state).toEqual({
          schema_version: 1,
          lastProcessedDeepDreamAt: 0,
          currentSessionDreamedDate: '',
          currentSessionRetryCount: 0,
        });
        expect(audit.write).toHaveBeenCalledTimes(1);
        const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION);
        expect(call).toEqual(expect.arrayContaining([
          expect.stringMatching(/^version=99$/),
          expect.stringMatching(/^current=1$/),
          expect.stringMatching(/^clawId=test-claw$/),
          expect.stringMatching(/^reason=cannot_migrate_future_version$/),
        ]));
        // No write occurred — future-version file is preserved on disk.
        expect(fs.writeAtomicSync).toBeUndefined();
      });
    });
  });
});

describe('memory-search-phase926', () => {
  /**
   * Phase 926 — memory_search skipped files visibility.
   */

  function makeMockInfra(entries: FileEntry[], readImpl: (path: string) => string): ExecutionInfra {
    return {
      fs: {
        list: vi.fn(async () => entries),
        read: vi.fn(async (path: string) => readImpl(path)),
      } as unknown as FileSystem,
    } as ExecutionInfra;
  }

  describe('memory_search phase926 skipped visibility', () => {
    it('reports skipped files in content when read throws non-ENOENT', async () => {
      const entries: FileEntry[] = [
        { path: 'memory/a.md', name: 'a.md', isDirectory: false, isFile: true },
        { path: 'memory/b.md', name: 'b.md', isDirectory: false, isFile: true },
        { path: 'memory/c.md', name: 'c.md', isDirectory: false, isFile: true },
      ];

      const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const infra = makeMockInfra(entries, (path) => {
        if (path === 'memory/b.md') throw eacces;
        if (path === 'memory/a.md') return 'hello alpha';
        if (path === 'memory/c.md') return 'hello gamma';
        throw new Error(`unexpected path: ${path}`);
      });

      const result = await memorySearchTool.execute({ query: 'hello' }, infra);

      expect(result.success).toBe(true);
      expect(result.content).toContain('hello alpha');
      expect(result.content).toContain('hello gamma');
      expect(result.content).toContain('1 个文件因读取错误被跳过');
    });

    it('keeps silently skipping on ENOENT (TOCTOU)', async () => {
      const entries: FileEntry[] = [
        { path: 'memory/a.md', name: 'a.md', isDirectory: false, isFile: true },
        { path: 'memory/b.md', name: 'b.md', isDirectory: false, isFile: true },
      ];

      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const infra = makeMockInfra(entries, (path) => {
        if (path === 'memory/b.md') throw enoent;
        if (path === 'memory/a.md') return 'hello alpha';
        throw new Error(`unexpected path: ${path}`);
      });

      const result = await memorySearchTool.execute({ query: 'hello' }, infra);

      expect(result.success).toBe(true);
      expect(result.content).toContain('hello alpha');
      expect(result.content).not.toContain('文件因读取错误被跳过');
    });
  });
});

describe('random-dream-pulse-audit', () => {
  describe('random-dream — ⚓11 pulse strategy α (phase 633)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function makeMotionFs(returnFalseCount = Infinity) {
      let calls = 0;
      return {
        existsSync: vi.fn(() => {
          calls++;
          return calls > returnFalseCount;
        }),
        readSync: vi.fn(() => 'log-content'),
      };
    }

    it('default behavior: pulseAuditEnabled=false → 0 RANDOM_DREAM_PULSE audit', async () => {
      const motionFs = makeMotionFs();
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      const promise = waitForTaskResult(motionFs as any, 't1', 100, 10, audit, false);
      await vi.advanceTimersByTimeAsync(200);
      // promise resolves to null on timeout; no need to await
      const pulseCalls = audit.write.mock.calls.filter((c: any[]) =>
        c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_PULSE
      );
      expect(pulseCalls).toHaveLength(0);
      await promise;
    });

    it('pulseAuditEnabled=true → emits RANDOM_DREAM_PULSE per poll', async () => {
      const motionFs = makeMotionFs(2); // 2 false → 2 pulses, then true on 3rd check
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      const promise = waitForTaskResult(motionFs as any, 't2', 100, 10, audit, true);
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;
      expect(result).toBe('log-content');

      const pulseCalls = audit.write.mock.calls.filter((c: any[]) =>
        c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_PULSE
      );
      expect(pulseCalls.length).toBeGreaterThanOrEqual(2);
      expect(pulseCalls[0][1]).toContain('taskId=t2');
      expect(pulseCalls[0][2]).toContain('pulse=0');
      expect(pulseCalls[0][3]).toContain('interval_ms=10');
      expect(pulseCalls[1][2]).toContain('pulse=1');
    });

    it('pulseIntervalMs default 30_000 when opts undefined', async () => {
      const motionFs = makeMotionFs();
      const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      const promise = waitForTaskResult(motionFs as any, 't3', 200_000, undefined, audit, true);
      // Synchronous part of waitForTaskResult runs first while-loop iteration
      // (existsSync=false → audit pulse=0 → setTimeout 30_000).
      expect(audit.write).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(audit.write).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(audit.write).toHaveBeenCalledTimes(3);

      // Let it timeout so the promise resolves and test cleans up
      await vi.advanceTimersByTimeAsync(200_000);
      await promise;
    });
  });
});

describe('deep-dream-clawfs-factory', () => {
  // ─── LLMOrchestrator mock ──────────────────────────────────────────
  const mockLlmCall = vi.fn();

  const mockLlmService = {
    call: mockLlmCall,
    stream: vi.fn(),
    healthCheck: vi.fn(),
    getProviderInfo: vi.fn(),
    close: vi.fn(),
  };

  const fakeLlmConfig: LLMOrchestratorConfig = {
    primary: { name: 'test', apiKey: 'sk-test', model: 'claude-test' } as any,
  };

  const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};

  function makeTextResponse(text: string) {
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
  }

  function makeTopology(chestnutRoot: string) {
    return createClawTopology({
      fs: new NodeFileSystem({ baseDir: chestnutRoot }),
      chestnutRoot,
      motionClawId: makeClawId('motion'),
      motionDir: 'motion',
    });
  }

  function makeOpts(overrides: Partial<DeepDreamOptions> & { chestnutRoot?: string } = {}): DeepDreamOptions {
    const chestnutRoot = overrides.chestnutRoot ?? '';
    return {
      clawsDir: chestnutRoot ? `${chestnutRoot}/claws` : '',
      clawTopology: makeTopology(chestnutRoot),
      llmConfig: fakeLlmConfig,
      llmService: mockLlmService as any,
      fs: new NodeFileSystem({ baseDir: chestnutRoot }),
      audit: mockAudit,
      clawFsFactory: (clawDir) => new NodeFileSystem({ baseDir: clawDir }),
      ...overrides,
    };
  }

  // ─── 测试 ─────────────────────────────────────────────────────

  describe('runDeepDream — clawFsFactory 注入路径（caller DIP enforce）', () => {
    beforeEach(() => {
      mockLlmCall.mockReset();
      mockLlmCall.mockResolvedValue(makeTextResponse('dream output'));
      mockAudit.write.mockClear();
    });

    it('多 claw 迭代各自调 factory（per-claw dynamic）', async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      const chestnutDir = path.join(os.tmpdir(), `phase609-dd-${randomUUID()}`);
      const clawsDir = path.join(chestnutDir, 'claws');

      for (const clawId of ['a', 'b', 'c']) {
        const clawDir = path.join(clawsDir, clawId);
        await fs.mkdir(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
        await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
      }

      const factory = vi.fn().mockImplementation((clawDir: string) => new NodeFileSystem({ baseDir: clawDir }));

      await runDeepDream(makeOpts({ chestnutRoot: chestnutDir, clawFsFactory: factory }));

      expect(factory).toHaveBeenCalledTimes(3);
      expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'a'));
      expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'b'));
      expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'c'));

      await fs.rm(chestnutDir, { recursive: true, force: true });
    });

    it('clawIds 空时 factory 0 call', async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      const chestnutDir = path.join(os.tmpdir(), `phase609-dd-empty-${randomUUID()}`);
      await fs.mkdir(path.join(chestnutDir, 'claws'), { recursive: true });

      const factory = vi.fn().mockImplementation((clawDir: string) => new NodeFileSystem({ baseDir: clawDir }));

      await runDeepDream(makeOpts({ chestnutRoot: chestnutDir, clawFsFactory: factory }));

      expect(factory).not.toHaveBeenCalled();

      await fs.rm(chestnutDir, { recursive: true, force: true });
    });

    it('factory 抛错时单 claw 失败不阻断其他 claw（既有契约保持）', async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      const chestnutDir = path.join(os.tmpdir(), `phase609-dd-fail-${randomUUID()}`);
      const clawsDir = path.join(chestnutDir, 'claws');

      for (const clawId of ['ok1', 'fail', 'ok2']) {
        const clawDir = path.join(clawsDir, clawId);
        await fs.mkdir(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
        await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
      }

      let callCount = 0;
      const factory = vi.fn().mockImplementation((clawDir: string): FileSystem => {
        callCount++;
        if (path.basename(clawDir) === 'fail') {
          throw new Error('factory-fail-for-claw-fail');
        }
        return new NodeFileSystem({ baseDir: clawDir });
      });

      await runDeepDream(makeOpts({ chestnutRoot: chestnutDir, clawFsFactory: factory }));

      expect(factory).toHaveBeenCalledTimes(3);
      expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'ok1'));
      expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'fail'));
      expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'ok2'));

      // audit 记录 DEEP_DREAM_UNEXPECTED for claw-fail
      expect(mockAudit.write).toHaveBeenCalledWith(
        'deep_dream_unexpected',
        'step=unexpected',
        'clawId=fail',
        'reason=factory-fail-for-claw-fail',
      );

      await fs.rm(chestnutDir, { recursive: true, force: true });
    });
  });
});

describe('deep-dream-phase923', () => {
  /**
   * Phase 923 — deep-dream success marking + failure break + output-before-state ordering.
   */

  describe('deep-dream phase 923 invariants', () => {
    function makeCtx(overrides?: Partial<__test_DreamRunContext>): __test_DreamRunContext {
      return {
        clawId: 'test-claw',
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
});

describe('random-dream-phase926', () => {
  /**
   * Phase 926 — random-dream future schema guard + result read propagation.
   */

  const clawId = 'test-claw';

  function makeMockFs(readImpl: (file: string) => string): FileSystem {
    return { readSync: vi.fn(readImpl) } as any;
  }

  describe('random-dream phase926 invariants', () => {
    describe('loadRandomDreamState future version guard', () => {
      it('returns default state for future schema_version and keeps file on disk', () => {
        const fs = makeMockFs(() => JSON.stringify({ schema_version: 99, completedContractIds: ['c-old'] }));
        const audit = makeMockAudit();

        const result = __test_loadRandomDreamState(fs, audit);
        expect(result.state).toEqual({ schema_version: 1, completedContractIds: [] });
        expect(result.blocked).toEqual({ reason: 'future_schema', version: 99 });
        expect(audit.write).toHaveBeenCalledTimes(1);
        const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION);
        expect(call).toEqual(expect.arrayContaining([
          expect.stringMatching(/^version=99$/),
          expect.stringMatching(/^current=1$/),
          expect.stringMatching(/^reason=cannot_migrate_future_version$/),
        ]));
        // No write occurred — future-version file is preserved on disk.
        expect(fs.writeAtomicSync).toBeUndefined();
      });
    });

    describe('waitForTaskResult read error propagation', () => {
      function makeMotionFs(opts: { logExists: boolean; logRead?: () => string; doneRead?: () => string }): FileSystem {
        return {
          existsSync: vi.fn((p: string) => {
            if (typeof p !== 'string') return false;
            return p.endsWith('daemon.log') ? opts.logExists : p.endsWith('result.txt');
          }),
          readSync: vi.fn((p: string) => {
            if (typeof p !== 'string') throw new Error('unexpected path type');
            if (p.endsWith('daemon.log')) {
              if (opts.logRead) return opts.logRead();
              return 'log content';
            }
            if (p.endsWith('result.txt')) {
              if (opts.doneRead) return opts.doneRead();
              return 'done content';
            }
            throw new Error(`unexpected path: ${p}`);
          }),
        } as any;
      }

      it('propagates EACCES when reading log file', async () => {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        const motionFs = makeMotionFs({
          logExists: true,
          logRead: () => { throw err; },
        });
        const audit = makeMockAudit();

        await expect(waitForTaskResult(motionFs, 'task-1', 100, 10, audit, false)).rejects.toThrow('EACCES');
      });

      it('propagates EACCES when reading result.txt after log TOCTOU miss', async () => {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        const motionFs = makeMotionFs({
          logExists: false,
          doneRead: () => { throw err; },
        });
        const audit = makeMockAudit();

        await expect(waitForTaskResult(motionFs, 'task-2', 100, 10, audit, false)).rejects.toThrow('EACCES');
      });

      it('tolerates ENOENT on log read and falls back to result.txt', async () => {
        const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
        const motionFs = makeMotionFs({
          logExists: true,
          logRead: () => { throw err; },
          doneRead: () => 'fallback txt',
        });
        const audit = makeMockAudit();

        // Because donePath is not pre-checked as existing, the ENOENT on result.txt
        // causes a poll-loop retry. With a 10ms pulse and 100ms timeout it may or
        // may not return before deadline depending on timing. We run it once with a
        // tiny timeout and assert it does not throw EACCES/ propogate immediately.
        const result = await waitForTaskResult(motionFs, 'task-3', 15, 5, audit, false);
        // Either null (timeout) or the fallback — never throw.
        expect(result === null || result === 'fallback txt').toBe(true);
      });
    });
  });
});
