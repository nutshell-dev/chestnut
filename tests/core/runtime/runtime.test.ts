/**
 * Phase 987 — Runtime LoadResult io_error handling tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { TestRuntime } from '../../helpers/test-runtime.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

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
