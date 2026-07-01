/**
 * Runtime ProcessBatch integration tests
 */

import type { RuntimeTestInternals } from '../helpers/runtime-test-internals.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Runtime } from '../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import type { InboxMessage } from '../../src/foundation/messaging/types.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';
import { runLegacyBatch } from '../helpers/legacy-process-batch.js';


describe('Runtime ProcessBatch', () => {
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

  describe('processBatch()', () => {
    it('should return 0 when inbox is empty', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const count = await runLegacyBatch(runtime);
      expect(count).toBe(0);
    });

    it('should process messages in priority order', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Create messages with different priorities
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const messages = [
        { name: 'normal_msg.md', priority: 'normal', content: 'Normal priority' },
        { name: 'critical_msg.md', priority: 'critical', content: 'Critical priority' },
        { name: 'high_msg.md', priority: 'high', content: 'High priority' },
      ];

      for (const msg of messages) {
        const content = `---
id: ${msg.name}
type: message
from: motion
priority: ${msg.priority}
timestamp: ${new Date().toISOString()}
---

${msg.content}
`;
        await fs.writeFile(path.join(pendingDir, msg.name), content);
      }

      // Mock LLM
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Processed batch' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // Process batch
      const count = await runLegacyBatch(runtime);
      expect(count).toBe(3);

      // Verify messages moved to done/
      const doneDir = path.join(clawDir, 'inbox', 'done');
      const doneFiles = await fs.readdir(doneDir);
      expect(doneFiles.length).toBe(3);

      // Verify LLM was called once (batch processing)
      expect(mockLLM.call).toHaveBeenCalledTimes(1);

      // phase 436: inbox messages are no longer merged; each becomes its own user message
      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMessages = callArgs.messages.filter((m: { role: string }) => m.role === 'user');
      expect(userMessages.length).toBe(3);
      // All three messages present, critical first
      const combined = userMessages.map((m: { content: string }) => m.content).join('\n');
      expect(combined).toContain('Critical priority');
      expect(combined).toContain('High priority');
      expect(combined).toContain('Normal priority');
      // Critical appears before High, High before Normal
      expect(combined.indexOf('Critical priority')).toBeLessThan(combined.indexOf('High priority'));
      expect(combined.indexOf('High priority')).toBeLessThan(combined.indexOf('Normal priority'));

      // phase 436 metadata assertions
      for (const m of userMessages) {
        expect(m.origin).toBe('system');
        expect(m.systemSubtype).toBe('message');
        expect(typeof m.addedAt).toBe('string');
      }
    });

    it('should move messages to done before LLM call', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Create a message
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

      // Mock LLM that checks if file was moved
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Done' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runLegacyBatch(runtime);

      // Pending should be empty
      const pendingFiles = await fs.readdir(pendingDir);
      expect(pendingFiles.filter(f => f.endsWith('.md')).length).toBe(0);

      // Done should have the file
      const doneDir = path.join(clawDir, 'inbox', 'done');
      const doneFiles = await fs.readdir(doneDir);
      expect(doneFiles.length).toBe(1);
    });

    it('onInboxMessages handler 失败 → audit inbox_handler_failed', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Seed inbox with 1 message
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const content = `---
id: test-msg
type: message
from: sender-claw
priority: normal
timestamp: ${new Date().toISOString()}
---

Test message
`;
      await fs.writeFile(path.join(pendingDir, 'test.md'), content);

      // Mock LLM
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Processed' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const audit: string[] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });

      const callbacks = {
        onInboxMessages: vi.fn().mockRejectedValue(new Error('handler boom')),
      };

      await runLegacyBatch(runtime, callbacks);

      expect(audit.some(e => /^inbox_handler_failed\thandler=onInboxMessages\treason=handler boom$/.test(e))).toBe(true);
      expect(callbacks.onInboxMessages).toHaveBeenCalled();
    });
  });

  // ─── inbox edge cases ────────────────────────────────────────────────────────
});
