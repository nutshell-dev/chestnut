/**
 * Runtime Init integration tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Runtime } from '../../src/core/runtime/index.js';
import { DIALOG_ARCHIVE_DIR } from '../../src/foundation/dialog-store/dirs.js';
import { INBOX_PENDING_DIR, OUTBOX_PENDING_DIR } from '../../src/foundation/messaging/dirs.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';


describe('Runtime Init', () => {
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

  describe('initialization', () => {
    it('should create all necessary directories', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      await runtime.initialize();

      // Check directories exist
      const dirs = [
        'dialog',
        DIALOG_ARCHIVE_DIR,
        INBOX_PENDING_DIR,
        OUTBOX_PENDING_DIR,
        'tasks',
        'memory',
        'contract',
        'skills',
        'clawspace',
        'logs',
      ];

      for (const dir of dirs) {
        const exists = await fs.stat(path.join(clawDir, dir)).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    });

    it('should be initialized after initialize()', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      expect(runtime.getStatus().initialized).toBe(false);
      await runtime.initialize();
      expect(runtime.getStatus().initialized).toBe(true);
    });

    it('sessionManager.archive() 非 ENOENT 失败 → audit session_archive_failed', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      const audit: string[] = [];
      vi.spyOn(deps.sessionManager, 'archive').mockRejectedValue(Object.assign(new Error('archive failed injected'), { code: 'EACCES' }));
      vi.spyOn(deps.auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });

      await runtime.initialize();

      expect(audit.some(e => /^session_archive_failed\treason=archive failed injected$/.test(e))).toBe(true);
    });

    it('sessionManager.archive() ENOENT → 不发 audit（first-run 合法）', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      const audit: string[] = [];
      vi.spyOn(deps.sessionManager, 'archive').mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
      vi.spyOn(deps.auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });

      await runtime.initialize();

      expect(audit.some(e => e.startsWith('session_archive_failed'))).toBe(false);
    });

    it('deps.parentStreamLog 构造期注入 → taskSystem.setParentStreamLog 已调', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const spy = vi.spyOn(deps.taskSystem, 'setParentStreamLog');
      const mockStreamLog = { write: vi.fn() } as any;
      (deps as any).parentStreamLog = mockStreamLog;
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      expect(spy).toHaveBeenCalledWith(mockStreamLog);
    });

    it('deps.contractNotifyCallback 构造期注入 → contractManager.setOnNotify 已调', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const spy = vi.spyOn(deps.contractManager, 'setOnNotify');
      const cb = vi.fn();
      (deps as any).contractNotifyCallback = cb;
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      expect(spy).toHaveBeenCalledWith(cb);
    });
  });

  describe('Runtime AsyncTaskSystem business actions (phase155C)', () => {
    it('taskSystem.initialize() 失败 → audit task_system_init_failed + throw', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      const audit: string[] = [];
      vi.spyOn(deps.taskSystem, 'initialize').mockRejectedValue(new Error('injected'));
      vi.spyOn(deps.auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });

      await expect(runtime.initialize()).rejects.toThrow(/AsyncTaskSystem\.initialize failed/);
      expect(audit.some(e => /^task_system_init_failed\treason=injected/.test(e))).toBe(true);
    });

    it('taskSystem.startDispatch() 失败 → audit task_system_start_dispatch_failed + throw', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      const audit: string[] = [];
      vi.spyOn(deps.taskSystem, 'startDispatch').mockImplementation(() => {
        throw new Error('injected');
      });
      vi.spyOn(deps.auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });

      await expect(runtime.initialize()).rejects.toThrow(/AsyncTaskSystem\.startDispatch failed/);
      expect(audit.some(e => /^task_system_start_dispatch_failed\treason=injected/.test(e))).toBe(true);
    });

    it('顺序门控：initialize() 抛错时 startDispatch() 不被调用', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      vi.spyOn(deps.taskSystem, 'initialize').mockRejectedValue(new Error('injected'));
      const startSpy = vi.spyOn(deps.taskSystem, 'startDispatch');

      await expect(runtime.initialize()).rejects.toThrow();
      expect(startSpy).not.toHaveBeenCalled();
    });

    it('Runtime 调序：taskSystem.initialize() 先于 startDispatch()', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      const methodOrder: string[] = [];
      vi.spyOn(deps.taskSystem, 'initialize').mockImplementation(async () => {
        methodOrder.push('initialize');
      });
      vi.spyOn(deps.taskSystem, 'startDispatch').mockImplementation(() => {
        methodOrder.push('startDispatch');
      });

      await runtime.initialize();
      expect(methodOrder).toEqual(['initialize', 'startDispatch']);
    });

    it('audit 写发生在 throw 之前（时机契约）', async () => {
      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const runtime = trackRuntime(new Runtime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      const auditTs: number[] = [];
      vi.spyOn(deps.taskSystem, 'initialize').mockRejectedValue(new Error('injected'));
      vi.spyOn(deps.auditWriter, 'write').mockImplementation((type: string) => {
        if (type === 'task_system_init_failed') auditTs.push(Date.now());
      });

      let throwTs = 0;
      try {
        await runtime.initialize();
      } catch {
        throwTs = Date.now();
      }

      expect(auditTs.length).toBe(1);
      expect(throwTs).toBeGreaterThan(0);
      expect(auditTs[0]).toBeLessThanOrEqual(throwTs);
    });
  });

  describe('chat()', () => {
    it('should return text response from LLM', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      // Mock LLM responses
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Hello from Claw!' }],
        stop_reason: 'end_turn',
      }]);

      // Replace LLM after initialization
      await runtime.initialize();
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const response = await runtime.chat('Hi!');
      expect(response).toBe('Hello from Claw!');
    });

    it('should maintain conversation history across calls', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      const mockLLM = createMockLLM([
        { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
        { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
      ]);

      await runtime.initialize();
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.chat('Message 1');
      await runtime.chat('Message 2');

      // LLM should have been called twice
      expect(mockLLM.call).toHaveBeenCalledTimes(2);

      // Second call should include history from first
      const secondCallArgs = mockLLM.call.mock.calls[1][0];
      expect(secondCallArgs.messages.length).toBeGreaterThan(1);
    });

    it('should save session after chat', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Saved!' }],
        stop_reason: 'end_turn',
      }]);

      await runtime.initialize();
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.chat('Save this');

      // Check current.json exists
      const currentPath = path.join(clawDir, 'dialog', 'current.json');
      const exists = await fs.stat(currentPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Check content
      const content = await fs.readFile(currentPath, 'utf-8');
      const session = JSON.parse(content);
      expect(session.clawId).toBe('test-claw');
      expect(session.messages.length).toBeGreaterThan(0);
    });
  });

  describe('status', () => {
    it('should return correct clawId', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'my-claw-123',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      expect(runtime.getStatus().clawId).toBe('my-claw-123');
    });
  });
});
