/**
 * ClawRuntime integration tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ClawRuntime } from '../../src/core/runtime.js';
import type { LLMServiceConfig } from '../../src/foundation/llm/types.js';
import type { LLMResponse } from '../../src/types/message.js';
import type { StreamChunk } from '../../src/foundation/llm/types.js';
import { MaxStepsExceededError } from '../../src/types/errors.js';
import type { Message } from '../../src/types/message.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../src/types/signals.js';
import type { InboxMessage } from '../../src/types/contract.js';

/**
 * Convert LLMResponse to stream chunks for mock
 */
async function* responseToStreamChunks(response: LLMResponse): AsyncIterableIterator<StreamChunk> {
  for (const block of response.content) {
    if (block.type === 'text') {
      yield { type: 'text_delta', delta: (block as { text: string }).text };
    } else if (block.type === 'tool_use') {
      const toolBlock = block as { id: string; name: string; input: unknown };
      yield {
        type: 'tool_use_start',
        toolUse: { id: toolBlock.id, name: toolBlock.name, partialInput: '' },
      };
      yield {
        type: 'tool_use_delta',
        toolUse: { id: '', name: '', partialInput: JSON.stringify(toolBlock.input) },
      };
    }
  }
  yield { type: 'done' };
}

async function createTempDir(): Promise<string> {
  const tempDir = path.join(tmpdir(), `clawforum-runtime-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function createMockLLMConfig(): LLMServiceConfig {
  return {
    primary: {
      name: 'mock',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: 30000,
      apiFormat: 'anthropic' as const,
    },
    maxAttempts: 1,
    retryDelayMs: 100,
  };
}

function createMockLLM(responses: LLMResponse[]) {
  let index = 0;
  const callMock = vi.fn(async () => {
    const response = responses[index++] || responses[responses.length - 1];
    return response;
  });
  return {
    call: callMock,
    stream: vi.fn((...args: unknown[]) => {
      // 复用 call mock 的返回值，转换为 stream chunks
      const result = callMock(...args);
      if (result instanceof Promise) {
        return (async function* () {
          const response = await result;
          yield* responseToStreamChunks(response as LLMResponse);
        })();
      }
      return responseToStreamChunks(result as LLMResponse);
    }),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  };
}

describe('ClawRuntime', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: ClawRuntime[] = [];

  function trackRuntime(r: ClawRuntime): ClawRuntime {
    runtimesToStop.push(r);
    return r;
  }

  beforeEach(async () => {
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
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      await runtime.initialize();

      // Check directories exist
      const dirs = [
        'dialog',
        'dialog/archive',
        'inbox/pending',
        'outbox/pending',
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
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      expect(runtime.getStatus().initialized).toBe(false);
      await runtime.initialize();
      expect(runtime.getStatus().initialized).toBe(true);
    });
  });

  describe('chat()', () => {
    it('should return text response from LLM', async () => {
      const runtime = trackRuntime(new ClawRuntime({
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
      const runtime = trackRuntime(new ClawRuntime({
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
      const runtime = trackRuntime(new ClawRuntime({
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
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'my-claw-123',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));

      expect(runtime.getStatus().clawId).toBe('my-claw-123');
    });
  });

  describe('processBatch()', () => {
    it('should return 0 when inbox is empty', async () => {
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const count = await runtime.processBatch();
      expect(count).toBe(0);
    });

    it('should process messages in priority order', async () => {
      const runtime = trackRuntime(new ClawRuntime({
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
      const count = await runtime.processBatch();
      expect(count).toBe(3);

      // Verify messages moved to done/
      const doneDir = path.join(clawDir, 'inbox', 'done');
      const doneFiles = await fs.readdir(doneDir);
      expect(doneFiles.length).toBe(3);

      // Verify LLM was called once (batch processing)
      expect(mockLLM.call).toHaveBeenCalledTimes(1);

      // Verify all inbox messages were merged into a single user message (priority order preserved)
      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMessages = callArgs.messages.filter((m: { role: string }) => m.role === 'user');
      expect(userMessages.length).toBe(1);
      // All three messages present, critical first
      const combined = userMessages[0].content;
      expect(combined).toContain('Critical priority');
      expect(combined).toContain('High priority');
      expect(combined).toContain('Normal priority');
      // Critical appears before High, High before Normal
      expect(combined.indexOf('Critical priority')).toBeLessThan(combined.indexOf('High priority'));
      expect(combined.indexOf('High priority')).toBeLessThan(combined.indexOf('Normal priority'));
    });

    it('should move messages to done before LLM call', async () => {
      const runtime = trackRuntime(new ClawRuntime({
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

      await runtime.processBatch();

      // Pending should be empty
      const pendingFiles = await fs.readdir(pendingDir);
      expect(pendingFiles.filter(f => f.endsWith('.md')).length).toBe(0);

      // Done should have the file
      const doneDir = path.join(clawDir, 'inbox', 'done');
      const doneFiles = await fs.readdir(doneDir);
      expect(doneFiles.length).toBe(1);
    });
  });

  describe('resumeContractIfPaused()', () => {
    it('should not throw when no active contract', async () => {
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Should not throw
      await expect(runtime.resumeContractIfPaused()).resolves.not.toThrow();
    });
  });

  // ─── inbox edge cases ────────────────────────────────────────────────────────

  describe('_drainOwnInbox edge cases', () => {
    async function makeRuntime() {
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();
      return runtime;
    }

    function writePendingMsg(pendingDir: string, filename: string, content: string) {
      return fs.writeFile(path.join(pendingDir, filename), content);
    }

    function validMsgContent(id: string, body: string, priority = 'normal') {
      return `---\nid: ${id}\ntype: message\nfrom: motion\npriority: ${priority}\ntimestamp: ${new Date().toISOString()}\n---\n\n${body}\n`;
    }

    it('non-.md files in inbox/pending are ignored', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // One valid message + one non-.md intruder
      await writePendingMsg(pendingDir, 'valid.md', validMsgContent('v1', 'hello'));
      await writePendingMsg(pendingDir, 'stray.tmp', 'not a markdown file');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const count = await runtime.processBatch();

      // The .tmp file is skipped but the .md is processed
      expect(count).toBe(1);
    });

    it('malformed frontmatter .md files are moved to failed/', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const failedDir = path.join(clawDir, 'inbox', 'failed');

      // Good message alongside broken one
      await writePendingMsg(pendingDir, 'good.md', validMsgContent('g1', 'good'));
      // File starts with --- but has no closing ---, so decodeInbox throws
      await writePendingMsg(pendingDir, 'broken.md', '---\ntype: message\nno-closing-dashes-ever');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // Should not throw; only the good message is processed
      await expect(runtime.processBatch()).resolves.toBe(1);

      // Broken file should end up in failed/
      const failedFiles = await fs.readdir(failedDir);
      expect(failedFiles.some(f => f.endsWith('broken.md'))).toBe(true);
    });

    it('heartbeat type without HEARTBEAT.md returns base text', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // No HEARTBEAT.md in clawDir — heartbeat catch block returns base
      await writePendingMsg(pendingDir, 'hb.md', `---\nid: hb1\ntype: heartbeat\nfrom: system\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\n`);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'checked' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Heartbeat triggered');
      // No checklist appended when HEARTBEAT.md is absent
      expect(userMsg?.content).not.toContain('\n\n');
    });

    it('heartbeat type with HEARTBEAT.md appends checklist', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // Write HEARTBEAT.md to clawDir
      await fs.writeFile(path.join(clawDir, 'HEARTBEAT.md'), '- Check disk space\n- Verify connections\n');

      await writePendingMsg(pendingDir, 'hb.md', `---\nid: hb2\ntype: heartbeat\nfrom: system\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\n`);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Heartbeat triggered');
      expect(userMsg?.content).toContain('Check disk space');
    });

    it('messages with to: a different agent are skipped from injection', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const doneDir = path.join(clawDir, 'inbox', 'done');

      // Write two messages: one to this agent, one to a subagent
      await writePendingMsg(
        pendingDir,
        'for-me.md',
        `---\nid: msg1\ntype: message\nfrom: motion\nto: test-claw\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nMessage for me`,
      );
      await writePendingMsg(
        pendingDir,
        'for-subagent.md',
        `---\nid: msg2\ntype: message\nfrom: task_system\nto: some-subagent-uuid\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nMessage for subagent`,
      );

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // processBatch drains inbox (2 files moved to done)
      await runtime.processBatch();

      // Only the message addressed to test-claw should be injected into LLM context
      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Message for me');
      expect(userMsg?.content).not.toContain('Message for subagent');

      // Both files should be moved to done/
      const doneFiles = await fs.readdir(doneDir);
      expect(doneFiles.some(f => f.endsWith('for-me.md'))).toBe(true);
      expect(doneFiles.some(f => f.endsWith('for-subagent.md'))).toBe(true);

      // Audit log should show inbox_unaddressed for the subagent message
      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const unaddressedEntry = entries.find((e: string[]) => e[1] === 'inbox_unaddressed');
      expect(unaddressedEntry).toBeDefined();
      expect(unaddressedEntry[5]).toContain('to=some-subagent-uuid');
    });

    it('should return 0 and not call LLM when all inbox messages are addressed to other agents', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // Both messages are addressed to other agents, not to 'test-claw'
      await writePendingMsg(
        pendingDir,
        'not-for-me-1.md',
        `---\nid: msg1\ntype: message\nfrom: task_system\nto: some-subagent-uuid\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nSubagent result`,
      );
      await writePendingMsg(
        pendingDir,
        'not-for-me-2.md',
        `---\nid: msg2\ntype: message\nfrom: task_system\nto: another-subagent\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nAnother result`,
      );

      const mockLLM = createMockLLM([]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const count = await runtime.processBatch();

      // count fix: returns injectedInfos.length (0), not fileInfos.length (2)
      expect(count).toBe(0);
      // No LLM turn should be triggered
      expect(mockLLM.call).not.toHaveBeenCalled();
    });

    it('inbox_unaddressed audit event written for messages to other agents', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      await writePendingMsg(
        pendingDir,
        'unaddressed.md',
        `---\nid: msg1\ntype: message\nfrom: motion\nto: other-claw\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nNot for me`,
      );

      const mockLLM = createMockLLM([]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const entry = entries.find((e: string[]) => e[1] === 'inbox_unaddressed');
      expect(entry).toBeDefined();
      expect(entry!.some((col: string) => col.includes('to=other-claw'))).toBe(true);
    });

    it('inbox_done audit event written for every processed file', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      await writePendingMsg(pendingDir, 'a.md', validMsgContent('a1', 'hello a'));
      await writePendingMsg(pendingDir, 'b.md', validMsgContent('b1', 'hello b'));

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const doneEntries = entries.filter((e: string[]) => e[1] === 'inbox_done');
      expect(doneEntries.length).toBe(2);
    });

    it('inbox_failed audit event written for malformed message', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      await writePendingMsg(pendingDir, 'good.md', validMsgContent('g1', 'good'));
      await writePendingMsg(pendingDir, 'broken.md', '---\ntype: message\nno-closing-dashes-ever');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const failedEntry = entries.find((e: string[]) => e[1] === 'inbox_failed');
      expect(failedEntry).toBeDefined();
      expect(failedEntry!.some((col: string) => col.includes('reason=Malformed frontmatter: missing closing ---'))).toBe(true);
    });

    // H3 fix: non-MaxSteps errors should notify sender via outbox
    it('should notify sender when LLM throws non-MaxSteps error (H3)', async () => {
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Create a message with 'source' field
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const content = `---
id: test-msg
type: message
source: motion
contract_id: test-contract
priority: normal
timestamp: ${new Date().toISOString()}
---

Test message`;
      await fs.writeFile(path.join(pendingDir, 'msg.md'), content);

      // Mock LLM that throws a non-MaxSteps error
      const failingLLM = {
        call: vi.fn().mockRejectedValue(new Error('LLM API crashed')),
        stream: vi.fn().mockImplementation(async function* () {
          throw new Error('LLM API crashed');
        }),
        close: vi.fn(),
      };
      (runtime as unknown as { llm: typeof failingLLM }).llm = failingLLM;

      // Should throw the error
      await expect(runtime.processBatch()).rejects.toThrow('LLM API crashed');

      // Verify error response was written to outbox
      const outboxDir = path.join(clawDir, 'outbox', 'pending');
      const outboxFiles = await fs.readdir(outboxDir);
      const responseFiles = outboxFiles.filter(f => f.endsWith('.md'));
      expect(responseFiles.length).toBeGreaterThan(0);

      // Verify the error response content
      const responseContent = await fs.readFile(
        path.join(outboxDir, responseFiles[0]),
        'utf-8'
      );
      expect(responseContent).toContain('# RESPONSE');
      expect(responseContent).toContain('**To:** motion');
      expect(responseContent).toContain('**Contract:** test-contract');
      expect(responseContent).toContain('Error: LLM API crashed');
    });

    // UserInterrupt should NOT notify sender (user aborted, not a real error)
    it('should NOT notify sender on UserInterrupt', async () => {
      // Use a subclass to inject UserInterrupt without going through real LLM+loop
      class UserInterruptRuntime extends ClawRuntime {
        protected override async _drainOwnInbox() {
          return {
            injected: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
            sources: [],
            count: 1,
            infos: [{
              id: 'msg1',
              type: 'message',
              from: 'motion',
              to: 'test-claw',
              content: 'hi',
              priority: 'normal',
              timestamp: new Date().toISOString(),
              contract_id: 'test-contract',
            } as InboxMessage],
          };
        }
        protected override async _runReact(_messages: Message[]) {
          throw new UserInterrupt();
        }
      }

      const runtime = trackRuntime(new UserInterruptRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      await expect(runtime.processBatch()).rejects.toBeInstanceOf(UserInterrupt);

      // Verify NO error response was written to outbox
      const outboxDir = path.join(clawDir, 'outbox', 'pending');
      const outboxFiles = await fs.readdir(outboxDir);
      const responseFiles = outboxFiles.filter(f => f.endsWith('.md'));
      expect(responseFiles.length).toBe(0);
    });

    it('injected message includes time-ago suffix when timestamp is set', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // 15 分钟前的消息
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      await writePendingMsg(
        pendingDir,
        'old.md',
        `---\nid: m1\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${fifteenMinAgo}\n---\n\nHello`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (runtime as any).llm = mockLLM;
      await runtime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toContain('15m ago');
    });

    it('injected message shows seconds for very recent timestamp', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // 5 秒前
      const fiveSecsAgo = new Date(Date.now() - 5_000).toISOString();
      await writePendingMsg(
        pendingDir,
        'fresh.md',
        `---\nid: m2\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${fiveSecsAgo}\n---\n\nFresh`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (runtime as any).llm = mockLLM;
      await runtime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toMatch(/\ds ago/);
    });

    it('injected message shows hours for timestamps over 60 minutes old', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await writePendingMsg(
        pendingDir,
        'old2.md',
        `---\nid: m3\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${twoHoursAgo}\n---\n\nBody`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (runtime as any).llm = mockLLM;
      await runtime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toContain('2h ago');
    });

    // Note: "timestamp missing" test removed because decodeInbox always fills a default
    // timestamp, so this edge case no longer exists on the InboxReader path.
  });

  // ─── retryLastTurn() ──────────────────────────────────────────────────────

  describe('retryLastTurn()', () => {
    it('returns immediately when session has no messages (empty session guard)', async () => {
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const mockLLM = createMockLLM([]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // No messages have been exchanged — session is empty
      await expect(runtime.retryLastTurn()).resolves.toBeUndefined();

      // LLM must NOT have been called
      expect(mockLLM.call).not.toHaveBeenCalled();
      expect(mockLLM.stream).not.toHaveBeenCalled();
    });

    it('replays last turn by calling LLM with existing session messages', async () => {
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Populate session via chat()
      const firstLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Initial answer' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof firstLLM }).llm = firstLLM;
      await runtime.chat('What is 2+2?');

      // Now replace LLM and retry — should call the NEW LLM with the saved session
      const retryLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Retry answer' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof retryLLM }).llm = retryLLM;

      await runtime.retryLastTurn();

      expect(retryLLM.call).toHaveBeenCalledTimes(1);
      const callArg = retryLLM.call.mock.calls[0][0];
      // The session messages from the first chat() exchange are included
      expect(callArg.messages.length).toBeGreaterThan(0);
    });

    it('cleans up AbortController even when _runReact throws', async () => {
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Build a session first
      const setupLLM = createMockLLM([
        { content: [{ type: 'text', text: 'setup' }], stop_reason: 'end_turn' },
      ]);
      (runtime as unknown as { llm: typeof setupLLM }).llm = setupLLM;
      await runtime.chat('setup');

      // Replace LLM with one that throws
      const failingLLM = {
        call: vi.fn().mockRejectedValue(new Error('LLM network error')),
        stream: vi.fn().mockImplementation(async function* () { throw new Error('LLM network error'); }),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
      };
      (runtime as unknown as { llm: typeof failingLLM }).llm = failingLLM;

      await expect(runtime.retryLastTurn()).rejects.toThrow('LLM network error');

      // finally block must have cleared the AbortController
      expect((runtime as unknown as { currentAbortController: unknown }).currentAbortController).toBeNull();
    });

    it('cleans up AbortController on successful completion', async () => {
      const runtime = trackRuntime(new ClawRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Build a session first
      const mockLLM = createMockLLM([
        { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
        { content: [{ type: 'text', text: 'retry ok' }], stop_reason: 'end_turn' },
      ]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;
      await runtime.chat('setup');

      await runtime.retryLastTurn();

      // AbortController must be null after retryLastTurn resolves
      expect((runtime as unknown as { currentAbortController: unknown }).currentAbortController).toBeNull();
    });
  });

  // ─── processBatch() outbox error-path edge cases ──────────────────────────

  describe('processBatch() — outbox error notification edge cases', () => {
    /**
     * 子类覆盖 _drainOwnInbox 和 _runReact，
     * 绕过真实 LLM / FS 调用，专注测试 catch 块行为。
     */
    class TestRuntime extends ClawRuntime {
      public drainResult: {
        injected: Message[];
        sources: Array<{ text: string; type: string }>;
        count: number;
        infos: InboxMessage[];
      } = { injected: [], sources: [], count: 0, infos: [] };
      public reactError: Error | null = null;

      protected override async _drainOwnInbox() {
        return this.drainResult;
      }

      protected override async _runReact(_messages: Message[]) {
        if (this.reactError) throw this.reactError;
      }
    }

    let testClawDir: string;
    let testTempDir: string;
    const edgeRuntimes: ClawRuntime[] = [];

    beforeEach(async () => {
      testTempDir = path.join(tmpdir(), `clawforum-runtime-edge-${randomUUID()}`);
      testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
      await fs.mkdir(testClawDir, { recursive: true });
    });

    afterEach(async () => {
      for (const r of edgeRuntimes.splice(0)) {
        await r.stop().catch(() => {});
      }
      await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => {});
    });

    it('MaxStepsExceededError 通知 sender 并重抛错误', async () => {
      const runtime = new TestRuntime({
        clawId: 'edge-claw',
        clawDir: testClawDir,
        llmConfig: createMockLLMConfig(),
      });
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      runtime.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1',
          type: 'message',
          from: 'sender-claw',
          to: 'edge-claw',
          content: 'hello',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          contract_id: 'c-1',
        } as InboxMessage],
      };
      runtime.reactError = new MaxStepsExceededError(10);

      // 错误应被重抛
      await expect(runtime.processBatch()).rejects.toThrow(MaxStepsExceededError);

      // outbox 应写入了错误响应
      const outboxDir = path.join(testClawDir, 'outbox', 'pending');
      const files = (await fs.readdir(outboxDir)).filter(f => f.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);

      const content = await fs.readFile(path.join(outboxDir, files[0]), 'utf-8');
      expect(content).toContain('Maximum steps');
      expect(content).toContain('sender-claw');
    });

    it('outbox write 失败不影响原始错误重抛', async () => {
      const runtime = new TestRuntime({
        clawId: 'edge-claw',
        clawDir: testClawDir,
        llmConfig: createMockLLMConfig(),
      });
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      runtime.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1',
          type: 'message',
          from: 'sender-claw',
          to: 'edge-claw',
          content: 'hello',
          priority: 'normal',
          timestamp: new Date().toISOString(),
        } as InboxMessage],
      };
      const originalError = new Error('LLM exploded');
      runtime.reactError = originalError;

      // 注入一个会抛出的 outboxWriter
      (runtime as any).outboxWriter = {
        write: async () => { throw new Error('outbox disk full'); },
      };

      // 应抛出原始错误，而非 outbox 错误
      const err = await runtime.processBatch().catch(e => e);
      expect(err).toBe(originalError);
      expect(err.message).toBe('LLM exploded');
    });
  });

  // ─── _handleTurnInterrupt dispatch ───────────────────────────────────────────

  describe('_handleTurnInterrupt()', () => {
    let runtime: ClawRuntime;
    let interruptTempDir: string;
    let interruptClawDir: string;

    beforeEach(async () => {
      interruptTempDir = path.join(tmpdir(), `clawforum-interrupt-test-${randomUUID()}`);
      interruptClawDir = path.join(interruptTempDir, 'claws', 'int-claw');
      await fs.mkdir(interruptClawDir, { recursive: true });
      runtime = new ClawRuntime({
        clawId: 'int-claw',
        clawDir: interruptClawDir,
        llmConfig: createMockLLMConfig(),
      });
      await runtime.initialize();
    });

    afterEach(async () => {
      await runtime.stop().catch(() => {});
      await fs.rm(interruptTempDir, { recursive: true, force: true }).catch(() => {});
    });

    it('IdleTimeoutSignal → onTurnInterrupted("idle_timeout", message with seconds)', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      (runtime as any)._handleTurnInterrupt(new IdleTimeoutSignal(30000), { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('idle_timeout', expect.stringContaining('30s'));
      expect(onTurnError).not.toHaveBeenCalled();
    });

    it('PriorityInboxInterrupt → onTurnInterrupted("priority_inbox")', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      (runtime as any)._handleTurnInterrupt(new PriorityInboxInterrupt(), { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('priority_inbox', expect.any(String));
      expect(onTurnError).not.toHaveBeenCalled();
    });

    it('UserInterrupt → onTurnInterrupted("user_interrupt")', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      (runtime as any)._handleTurnInterrupt(new UserInterrupt(), { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('user_interrupt');  // 无 message，让 viewport 自行决定显示
      expect(onTurnError).not.toHaveBeenCalled();
    });

    it('Error → onTurnError with message', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      (runtime as any)._handleTurnInterrupt(new Error('LLM failure'), { onTurnInterrupted, onTurnError });
      expect(onTurnError).toHaveBeenCalledWith('LLM failure');
      expect(onTurnInterrupted).not.toHaveBeenCalled();
    });

    it('non-Error value → onTurnError with string', () => {
      const onTurnError = vi.fn();
      (runtime as any)._handleTurnInterrupt('raw string error', { onTurnError });
      expect(onTurnError).toHaveBeenCalledWith('raw string error');
    });
  });

  // ─── processBatch outbox exclusion for signal interrupts ─────────────────────

  describe('processBatch() — signal interrupts do not send outbox notifications', () => {
    class SignalTestRuntime extends ClawRuntime {
      public drainResult: {
        injected: Message[];
        sources: Array<{ text: string; type: string }>;
        count: number;
        infos: Array<{ meta: Record<string, string>; body?: string }>;
      } = { injected: [], sources: [], count: 0, infos: [] };
      public reactThrow: unknown = null;

      protected override async _drainOwnInbox() {
        return this.drainResult as any;
      }

      protected override async _runReact(_messages: Message[]) {
        if (this.reactThrow) throw this.reactThrow;
      }
    }

    let tempDir2: string;
    let clawDir2: string;
    const signalRuntimes: ClawRuntime[] = [];

    beforeEach(async () => {
      tempDir2 = path.join(tmpdir(), `clawforum-signal-test-${randomUUID()}`);
      clawDir2 = path.join(tempDir2, 'claws', 'sig-claw');
      await fs.mkdir(clawDir2, { recursive: true });
    });

    afterEach(async () => {
      for (const r of signalRuntimes.splice(0)) {
        await r.stop().catch(() => {});
      }
      await fs.rm(tempDir2, { recursive: true, force: true }).catch(() => {});
    });

    async function makeSignalRuntime() {
      const r = new SignalTestRuntime({
        clawId: 'sig-claw',
        clawDir: clawDir2,
        llmConfig: createMockLLMConfig(),
      });
      signalRuntimes.push(r);
      await r.initialize();
      r.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1',
          type: 'message',
          from: 'sender-claw',
          to: 'sig-claw',
          content: 'hi',
          priority: 'normal',
          timestamp: new Date().toISOString(),
        } as InboxMessage],
      };
      return r;
    }

    async function outboxFiles() {
      const dir = path.join(clawDir2, 'outbox', 'pending');
      return (await fs.readdir(dir)).filter(f => f.endsWith('.md'));
    }

    it('IdleTimeoutSignal — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new IdleTimeoutSignal(30000);
      await expect(r.processBatch()).rejects.toBeInstanceOf(IdleTimeoutSignal);
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('PriorityInboxInterrupt — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new PriorityInboxInterrupt();
      await expect(r.processBatch()).rejects.toBeInstanceOf(PriorityInboxInterrupt);
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('UserInterrupt — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new UserInterrupt();
      await expect(r.processBatch()).rejects.toBeInstanceOf(UserInterrupt);
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('generic Error — outbox notification IS sent to sender', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new Error('unexpected crash');
      await expect(r.processBatch()).rejects.toThrow('unexpected crash');
      const files = await outboxFiles();
      expect(files.length).toBeGreaterThan(0);
    });
  });

  // ─── onProviderInfo ───────────────────────────────────────────────────────────

  describe('onProviderInfo', () => {
    let piTempDir: string;
    let piClawDir: string;
    const piRuntimes: ClawRuntime[] = [];

    beforeEach(async () => {
      piTempDir = path.join(tmpdir(), `clawforum-pi-test-${randomUUID()}`);
      piClawDir = path.join(piTempDir, 'claws', 'pi-claw');
      await fs.mkdir(piClawDir, { recursive: true });
    });

    afterEach(async () => {
      for (const r of piRuntimes.splice(0)) {
        await r.stop().catch(() => {});
      }
      await fs.rm(piTempDir, { recursive: true, force: true }).catch(() => {});
    });

    it('首个 text_delta 触发 onProviderInfo，携带 getProviderInfo() 返回值', async () => {
      const runtime = new ClawRuntime({
        clawId: 'pi-claw',
        clawDir: piClawDir,
        llmConfig: createMockLLMConfig(),
      });
      piRuntimes.push(runtime);
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
      }]);
      mockLLM.getProviderInfo.mockReturnValue({ name: 'anthropic', model: 'claude-opus-4-6', isFallback: false });

      await runtime.initialize();
      (runtime as any).llm = mockLLM;

      const onProviderInfo = vi.fn();
      await runtime.chat('Hi', { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledTimes(1);
      expect(onProviderInfo).toHaveBeenCalledWith({ name: 'anthropic', model: 'claude-opus-4-6', isFallback: false });
    });

    it('同一 turn 多个 delta 只触发一次', async () => {
      const runtime = new ClawRuntime({
        clawId: 'pi-claw',
        clawDir: piClawDir,
        llmConfig: createMockLLMConfig(),
      });
      piRuntimes.push(runtime);

      // 用自定义 stream mock 产生多个 text_delta
      const multiDeltaLLM = {
        call: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'abc' }], stop_reason: 'end_turn' }),
        stream: vi.fn(async function* () {
          yield { type: 'text_delta', delta: 'a' };
          yield { type: 'text_delta', delta: 'b' };
          yield { type: 'text_delta', delta: 'c' };
          yield { type: 'done' };
        }),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
        getProviderInfo: vi.fn().mockReturnValue({ name: 'anthropic', model: 'claude-opus-4-6', isFallback: false }),
      };

      await runtime.initialize();
      (runtime as any).llm = multiDeltaLLM;

      const onProviderInfo = vi.fn();
      await runtime.chat('Hi', { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledTimes(1);
    });

    it('fallback provider 时 isFallback=true 被传递', async () => {
      const runtime = new ClawRuntime({
        clawId: 'pi-claw',
        clawDir: piClawDir,
        llmConfig: createMockLLMConfig(),
      });
      piRuntimes.push(runtime);
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Hi' }],
        stop_reason: 'end_turn',
      }]);
      mockLLM.getProviderInfo.mockReturnValue({ name: 'openai', model: 'gpt-4o', isFallback: true });

      await runtime.initialize();
      (runtime as any).llm = mockLLM;

      const onProviderInfo = vi.fn();
      await runtime.chat('Hi', { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledWith(
        expect.objectContaining({ isFallback: true, name: 'openai' })
      );
    });

    it('连续两个 turn 各触发一次（每 turn 独立计数）', async () => {
      const runtime = new ClawRuntime({
        clawId: 'pi-claw',
        clawDir: piClawDir,
        llmConfig: createMockLLMConfig(),
      });
      piRuntimes.push(runtime);
      const mockLLM = createMockLLM([
        { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
        { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
      ]);
      await runtime.initialize();
      (runtime as any).llm = mockLLM;

      const onProviderInfo = vi.fn();
      await runtime.chat('Turn 1', { onProviderInfo });
      await runtime.chat('Turn 2', { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledTimes(2);
    });
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

      const runtime = trackRuntime(new ClawRuntime({
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
      expect(sessionLoadedIndex).toBeGreaterThanOrEqual(0);
    });
  });
});
