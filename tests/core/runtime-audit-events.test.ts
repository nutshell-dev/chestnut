/**
 * Runtime audit events tests (phase 1296 split from runtime-signal-audit.test.ts)
 *
 * 5 describes / 9 tests covering:
 * - session_loaded audit timing
 * - Runtime session-repair failure branches
 * - Runtime audit events - turn lifecycle direct assertion
 * - Runtime audit events - llm_call / llm_error
 * - Runtime audit events - inbox_meta_failed (zero-coverage)
 *
 * Mirror phase 1293 stream-reader-robustness split / phase 1292 chat-viewport-regression split.
 * Estimated wall: ~1.8s (vs original file mean 3.6s / -49% combined parallel).
 */

import type { RuntimeTestInternals } from '../helpers/runtime-test-internals.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { writeSessionWithIncompleteToolUse } from '../helpers/session-fixtures.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';

describe('Runtime audit events', () => {
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
      await r.stop().catch(() => {});
    }
    await cleanupTempDir(tempDir);
  });

  describe('session_loaded audit timing', () => {
    it('session_loaded should not pollute summarizeLastExit tail-read on restart', async () => {
      const clawDir = await fs.mkdtemp(path.join(tmpdir(), 'clawforum-runtime-audit-'));
      const clawSubDir = path.join(clawDir, 'claws', 'audit-claw');
      await fs.mkdir(clawSubDir, { recursive: true });

      // 构造一个带有 daemon_stop 的 audit.tsv（模拟正常退出的上一次运行）
      const auditPath = path.join(clawSubDir, 'audit.tsv');
      await fs.writeFile(auditPath, `2026-04-17T00:00:00.000Z\tdaemon_stop\treason=sigterm\n`);

      // 不创建 dialog/current.json，使 sessionManager.load() 返回 empty session

      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'audit-claw',
        clawDir: clawSubDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // 读取 initialize 后 audit.tsv 的内容
      const auditContent = await fs.readFile(auditPath, 'utf-8');
      const lines = auditContent.trim().split('\n');

      // 验证 audit.tsv 中 daemon_stop 在 session_loaded 之前——
      // 如果 session_loaded 在 summarizeLastExit 之前写入，当初 summarizeLastExit 读到的就会是 session_loaded 而非 daemon_stop
      const sessionLoadedIndex = lines.findIndex((l: string) => l.includes('session_loaded'));
      const daemonStopIndex = lines.findIndex((l: string) => l.includes('daemon_stop'));
      expect(sessionLoadedIndex).toBeGreaterThan(daemonStopIndex);

      // 验证 session_loaded 确实被写入了
      expect(sessionLoadedIndex).not.toBe(-1);
    });
  });

  describe('Runtime session-repair failure branches (phase155C)', () => {
    it('snapshot.commit 抛错 → audit snapshot_commit_failed context=session-repair + 不抛', async () => {
      const tmpDir = path.join(tmpdir(), `clawforum-repair-test-${randomUUID()}`);
      const clawSubDir = path.join(tmpDir, 'claws', 'repair-claw');
      await fs.mkdir(clawSubDir, { recursive: true });
      await writeSessionWithIncompleteToolUse(clawSubDir, 'repair-claw');

      const deps = await makeRuntimeDeps({ clawId: 'repair-claw', clawDir: clawSubDir });
      vi.spyOn(deps.taskSystem, 'initialize').mockResolvedValue(undefined);
      vi.spyOn(deps.taskSystem, 'startDispatch').mockImplementation(() => {});

      const events: string[] = [];
      vi.spyOn(deps.auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        events.push([type, ...args].join('\t'));
      });
      vi.spyOn(deps.snapshot, 'commit').mockRejectedValue(new Error('injected fs error'));

      const runtime = new Runtime({
        clawId: 'repair-claw',
        clawDir: clawSubDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      });

      await expect(runtime.initialize()).resolves.not.toThrow();

      expect(events.some(e =>
        /^snapshot_commit_failed\tcontext=session-repair\treason=injected fs error/.test(e)
      )).toBe(true);

      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('snapshot.commit 返 uncategorized error → audit snapshot_commit_uncategorized + 不抛', async () => {
      const tmpDir = path.join(tmpdir(), `clawforum-repair-test-${randomUUID()}`);
      const clawSubDir = path.join(tmpDir, 'claws', 'repair-claw');
      await fs.mkdir(clawSubDir, { recursive: true });
      await writeSessionWithIncompleteToolUse(clawSubDir, 'repair-claw');

      const deps = await makeRuntimeDeps({ clawId: 'repair-claw', clawDir: clawSubDir });
      vi.spyOn(deps.taskSystem, 'initialize').mockResolvedValue(undefined);
      vi.spyOn(deps.taskSystem, 'startDispatch').mockImplementation(() => {});

      const events: string[] = [];
      vi.spyOn(deps.auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        events.push([type, ...args].join('\t'));
      });
      vi.spyOn(deps.snapshot, 'commit').mockResolvedValue({
        ok: false,
        error: { kind: 'uncategorized', exitCode: 127 },
      } as any);

      const runtime = new Runtime({
        clawId: 'repair-claw',
        clawDir: clawSubDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      });

      await expect(runtime.initialize()).resolves.not.toThrow();

      expect(events.some(e =>
        /^snapshot_commit_uncategorized\tcontext=session-repair\texitCode=127/.test(e)
      )).toBe(true);

      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });
  });

  // ─── Runtime audit events direct assertion (phase405) ────────────────────────

  describe('Runtime audit events - turn lifecycle direct assertion', () => {
    it('processBatch emits turn_start + turn_end on success', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const content = `---
id: test-msg
type: message
from: motion
priority: normal
timestamp: ${new Date().toISOString()}
---

Test message
`;
      await fs.writeFile(path.join(pendingDir, 'test.md'), content);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Processed' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;

      const auditSpy = vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write');
      await runtime.processBatch();
      const calls = auditSpy.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain('turn_start');
      expect(calls).toContain('turn_end');
      auditSpy.mockRestore();
    });

    it('processWithMessage emits turn_start + turn_end on success', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Reply' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;

      const auditSpy = vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write');
      await runtime.processWithMessage({ role: 'user', content: 'hello' });
      const calls = auditSpy.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain('turn_start');
      expect(calls).toContain('turn_end');
      auditSpy.mockRestore();
    });

    it('retryLastTurn emits turn_start + turn_end on success', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const mockLLM = createMockLLM([
        { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
        { content: [{ type: 'text', text: 'Retry' }], stop_reason: 'end_turn' },
      ]);
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;
      await runtime.chat('setup');

      const auditSpy = vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write');
      await runtime.retryLastTurn();
      const calls = auditSpy.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain('turn_start');
      expect(calls).toContain('turn_end');
      auditSpy.mockRestore();
    });
  });

  describe('Runtime audit events - llm_call / llm_error', () => {
    it('LLM success emits llm_call with model/tokens/ms', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const content = `---
id: test-msg
type: message
from: motion
priority: normal
timestamp: ${new Date().toISOString()}
---

Test message
`;
      await fs.writeFile(path.join(pendingDir, 'test.md'), content);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Processed' }],
        stop_reason: 'end_turn',
      }]);
      mockLLM.getProviderInfo.mockReturnValue({ name: 'mock', model: 'test-model', isFallback: false });
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;

      const auditSpy = vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write');
      await runtime.processBatch();
      expect(auditSpy).toHaveBeenCalledWith('llm_call', 'test-model', expect.stringContaining('in='), expect.stringContaining('out='), expect.stringContaining('latency_ms='));
      auditSpy.mockRestore();
    });

    it('LLM failure emits llm_error with model/err/ms', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const content = `---
id: test-msg
type: message
from: motion
priority: normal
timestamp: ${new Date().toISOString()}
---

Test message
`;
      await fs.writeFile(path.join(pendingDir, 'test.md'), content);

      const failingLLM = {
        call: vi.fn().mockRejectedValue(new Error('LLM network error')),
        stream: vi.fn().mockImplementation(async function* () { throw new Error('LLM network error'); }),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
        getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'failing-model', isFallback: false }),
      };
      (runtime as unknown as RuntimeTestInternals).llm = failingLLM;

      const auditSpy = vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write');
      await expect(runtime.processBatch()).rejects.toThrow('LLM network error');
      expect(auditSpy).toHaveBeenCalledWith('llm_error', 'failing-model', expect.stringContaining('error='), expect.stringContaining('latency_ms='));
      auditSpy.mockRestore();
    });
  });

  describe('Runtime audit events - inbox_meta_failed (zero-coverage)', () => {
    it('_hasHighPriorityInbox emits inbox_meta_failed when readMeta fails', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Write a malformed .md file to pending inbox so InboxWriter.readMeta returns parse_failed
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      await fs.writeFile(path.join(pendingDir, 'bad.md'), '---\nthis is not valid frontmatter');

      const auditSpy = vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write');
      const result = await (runtime as unknown as RuntimeTestInternals)._hasHighPriorityInbox();
      expect(result).toBe(false);
      expect(auditSpy).toHaveBeenCalledWith('inbox_meta_failed', expect.stringContaining('file='), expect.stringContaining('kind='));
      auditSpy.mockRestore();
    });
  });
});
