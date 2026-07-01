import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Runtime } from '../../../src/core/runtime/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from '../_runtime-test-helpers.js';
import { runLegacyBatch } from '../../helpers/legacy-process-batch.js';

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
