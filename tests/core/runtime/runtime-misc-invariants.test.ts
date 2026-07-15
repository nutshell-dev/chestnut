/**
 * runtime misc invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - runtime.test.ts
 *  - dialog_persist_under_trim.test.ts
 *  - permission-checker-injection.test.ts
 *  - runtime-heartbeat-checklist-read-failed.test.ts
 *  - react-loop-audit-events-equiv.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { TestRuntime } from '../../helpers/test-runtime.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import { executeStep } from '../../../src/core/step-executor/step-executor.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { createMockLLMConfig } from '../_runtime-test-helpers.js';
import { createFileTools } from '../../../src/foundation/file-tool/index.js';
import { createHeartbeatInboxFormatter } from '../../../src/core/heartbeat/index.js';
import { HEARTBEAT_AUDIT_EVENTS } from '../../../src/core/heartbeat/audit-events.js';
import { REACT_LOOP_AUDIT_EVENTS as RUNTIME_RL } from '../../../src/core/runtime/runtime-audit-events.js';
import { REACT_LOOP_AUDIT_EVENTS as SUBAGENT_RL } from '../../../src/core/subagent/audit-events.js';

describe('runtime', () => {
  /**
   * Phase 987 — Runtime LoadResult io_error handling tests.
   */

  function createMockLLMConfig() {
    return {
      provider: 'anthropic' as const,
      model: 'claude-3-opus-20240229',
      apiKey: 'test-key',
      baseUrl: 'https://test.example.com',
    };
  }

  describe('Runtime LoadResult io_error handling (phase 987)', () => {
    let testTempDir: string;
    let testClawDir: string;
    const runtimes: Runtime[] = [];

    beforeEach(async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      testTempDir = path.join(tmpdir(), `chestnut-runtime-ioerror-${randomUUID()}`);
      testClawDir = path.join(testTempDir, 'claws', 'test-claw');
      await fs.mkdir(testClawDir, { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(async () => {
      for (const r of runtimes.splice(0)) {
        await r.stop().catch(() => { /* silent: shutdown */ });
      }
      await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    async function makeRuntime() {
      const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'test-claw' });
      const runtime = new TestRuntime({
        clawId: 'test-claw',
        clawDir: testClawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
        idleTimeoutMs: 0,
      });
      runtimes.push(runtime);
      await runtime.initialize();
      return runtime;
    }

    it('processWithMessage throws when sessionManager.load returns io_error', async () => {
      const runtime = await makeRuntime();
      const sessionManager = runtime.testGetSessionManager();
      vi.spyOn(sessionManager, 'load').mockResolvedValue({
        source: 'io_error',
        error: 'EIO',
        session: null,
      } as any);

      const msg = { role: 'user', content: 'hello' } as Message;
      await expect(runtime.processWithMessage(msg)).rejects.toThrow('Session load failed');
    });
  });
});

describe('dialog_persist_under_trim', () => {
  describe('runtime/step-executor dialog persist invariant under trim (phase 224)', () => {
    it('trim 触发条件下 step 完成后、caller 持引用应含本步 assistant 内容', async () => {
      // 构造多条 messages：中间一条超大 assistant 可被 trim、首尾 user 受保护
      // phase 255 → phase 286: shrink further (30000 → 22000) — still > 64k tokens which
      // exceeds the deepseek-chat budget, so trim still triggers; tiktoken encodes ~265k
      // chars instead of ~390k.
      const bigAssistant: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello world '.repeat(22000) }],
      };
      const messages: Message[] = [
        { role: 'user', content: 'hi' },
        bigAssistant,
        { role: 'user', content: 'bye' },
      ];
      const messagesRef = messages;

      const mockLLM = {
        stream: async function* () {
          yield { type: 'text_delta' as const, delta: 'ok' };
          yield { type: 'done' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 100, outputTokens: 5 } };
        },
        getProviderInfo: () => ({ model: 'deepseek-chat', name: 'deepseek-chat' }),
      };

      await executeStep({
        messages,
        systemPrompt: 'sys',
        llm: mockLLM as any,
        tools: [],
        executor: {} as any,
        registry: {} as any,
        ctx: { stepNumber: 0 as any, signal: undefined, trace_id: undefined } as any,
        callbacks: {},
        maxTokens: 1000,
      });

      // 关键 invariant：caller 持的原 messages 引用应被 push、不被切断
      expect(messagesRef).toBe(messages);
      expect(messagesRef.length).toBeGreaterThanOrEqual(4); // user + assistant(big) + user + new assistant
      expect(messagesRef.at(-1)?.role).toBe('assistant');
    });
  });
});

describe('permission-checker-injection', () => {
  /**
   * Phase 1273: permissionChecker injected into main runtime ExecContext
   *
   * 反向：
   * 1. main runtime ExecContext.permissionChecker !== undefined after initialize
   * 2. main agent file-tool write 实测调通 (不抛 not-injected error)
   * 3. RuntimeDependencies 缺 permissionChecker 时 tsc compile fail (type-level)
   */

  describe('phase 1273: permissionChecker injected into main runtime ExecContext', () => {
    let tmpDir: string;
    let clawDir: string;

    beforeAll(async () => {
      tmpDir = await createTrackedTempDir('cf-phase1273-');
      clawDir = path.join(tmpDir, 'test-claw');
      fsSync.mkdirSync(clawDir, { recursive: true });
    });

    afterAll(async () => {
      await cleanupTempDir(tmpDir);
    });

    it('反向 1: main runtime ExecContext.permissionChecker !== undefined after initialize', async () => {
      const deps = await makeRuntimeDeps({
        clawDir,
        clawId: 'test-claw',
        llmConfig: createMockLLMConfig(),
      });
      const runtime = new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        maxSteps: 10,
        dependencies: deps,
      });
      await runtime.initialize();

      const ctx = (runtime as any).execContext;
      expect(ctx.permissionChecker).toBeDefined();
      expect(typeof ctx.permissionChecker.checkRead).toBe('function');
      expect(typeof ctx.permissionChecker.checkWrite).toBe('function');

      await runtime.stop();
    });

    it('反向 2: main agent file-tool write 实测调通 (不抛 not-injected error)', async () => {
      const deps = await makeRuntimeDeps({
        clawDir,
        clawId: 'test-claw',
        llmConfig: createMockLLMConfig(),
      });
      const runtime = new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        maxSteps: 10,
        dependencies: deps,
      });
      await runtime.initialize();

      const ctx = (runtime as any).execContext;
      const tools = createFileTools();
      const writeTool = tools.find((t: any) => t.name === 'write');
      expect(writeTool).toBeDefined();

      const result = await writeTool!.execute({ path: 'test-phase1273.txt', content: 'hello' }, ctx);
      expect(result.success).toBe(true);

      await runtime.stop();
    });

    it('反向 3 (type-level): RuntimeDependencies 缺 permissionChecker 时 tsc compile fail', () => {
      // @ts-expect-error - permissionChecker required by phase 1273
      const badDeps: import('../../../src/core/runtime/index.js').RuntimeDependencies = {};
      expect(badDeps).toBeDefined(); // 运行时占位，编译期由 @ts-expect-error 验证
    });
  });
});

describe('runtime-heartbeat-checklist-read-failed', () => {
  /**
   * Heartbeat — HEARTBEAT.md read failed observability (r124 D fork phase 1018)
   *
   * Covers:
   * - ENOENT (not configured) → silent skip, returns base, 0 audit
   * - non-ENOENT (EACCES/IO) → audit CHECKLIST_READ_FAILED, still returns base graceful degrade
   * - Happy path (checklist present) → returns base + checklist, 0 audit
   *
   * phase 1414 cascade: 测试入口从 Runtime.formatInboxMessage 迁到 Heartbeat
   * 自家 inbox-formatter（per A.phase1414-formatter-registry-wiring 业主自管）。
   * 行为不变（phase 1018 r124 D fork 立场保留）、入口迁主。
   */

  describe('heartbeat inbox-formatter HEARTBEAT.md read failed audit (phase 1414 cascade)', () => {
    it('reverse 1: ENOENT (HEARTBEAT.md not configured) returns base + 0 audit', async () => {
      const auditSpy = vi.fn();
      const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const systemFs = {
        read: vi.fn().mockRejectedValue(enoent),
      } as any;
      const formatter = createHeartbeatInboxFormatter({ systemFs, audit: { write: auditSpy , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any });

      const result = await formatter({ from: 'sys', body: 'body', timestampSec: '' });

      expect(result).toContain('Heartbeat triggered');
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('reverse 2: EACCES (permission) emits CHECKLIST_READ_FAILED audit + returns base', async () => {
      const auditSpy = vi.fn();
      const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const systemFs = {
        read: vi.fn().mockRejectedValue(eacces),
      } as any;
      const formatter = createHeartbeatInboxFormatter({ systemFs, audit: { write: auditSpy , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any });

      const result = await formatter({ from: 'sys', body: 'body', timestampSec: '' });

      expect(result).toContain('Heartbeat triggered');
      const emits = auditSpy.mock.calls.filter((c: any[]) => c[0] === HEARTBEAT_AUDIT_EVENTS.CHECKLIST_READ_FAILED);
      expect(emits).toHaveLength(1);
      expect(emits[0].join('|')).toMatch(/code=EACCES/);
    });

    it('reverse 3: happy path checklist configured returns base + checklist + 0 audit', async () => {
      const auditSpy = vi.fn();
      const systemFs = {
        read: vi.fn().mockResolvedValue('- item A\n- item B'),
      } as any;
      const formatter = createHeartbeatInboxFormatter({ systemFs, audit: { write: auditSpy , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any });

      const result = await formatter({ from: 'sys', body: 'body', timestampSec: '' });

      expect(result).toContain('Heartbeat triggered');
      expect(result).toContain('item A');
      expect(result).toContain('item B');
      expect(auditSpy).not.toHaveBeenCalled();
    });
  });
});

describe('react-loop-audit-events-equiv', () => {
  /**
   * phase 272 Step E: REACT_LOOP_AUDIT_EVENTS 机械等价 test
   *
   * Phase 375 裁决 2 主动设计「不抽共享层 / 手工 mirror」、注释明示「0 漂移」。
   * 历史 phase 63 + subagent 未同步实证：手工 mirror 机制无机械守约 → 漂。
   * 本 test 守约：runtime + subagent 两 const 必字面等价、NEW const 时同步 fail 强制 sync。
   */

  describe('REACT_LOOP_AUDIT_EVENTS 跨 file equivalence (phase 272 Step E)', () => {
    it('runtime + subagent keys 完全等价', () => {
      const runtimeKeys = Object.keys(RUNTIME_RL).sort();
      const subagentKeys = Object.keys(SUBAGENT_RL).sort();
      expect(subagentKeys).toEqual(runtimeKeys);
    });

    it('runtime + subagent values 完全等价 (per key)', () => {
      for (const key of Object.keys(RUNTIME_RL)) {
        expect((SUBAGENT_RL as Record<string, string>)[key]).toBe(
          (RUNTIME_RL as Record<string, string>)[key],
        );
      }
    });

    it('runtime + subagent same const reference (object structural equal)', () => {
      // 用 const object structural compare 全键值守
      expect(SUBAGENT_RL).toEqual(RUNTIME_RL);
    });
  });
});
