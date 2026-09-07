/**
 * Runtime read-state step boundary — Phase 1229 Step A
 *
 * Verifies that Runtime calls FileTool's persistence primitive exactly once per
 * complete step, after the dialog snapshot has been saved, and awaits it before
 * the step is considered complete.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import * as loopModule from '../../../src/core/agent-executor/loop.js';
import * as persistModule from '../../../src/foundation/file-tool/file-state-persist.js';
import { READ_STATE_FILE } from '../../../src/foundation/file-tool/file-state-persist.js';
import type { ReactResult } from '../../../src/core/agent-executor/loop.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { runLegacyBatch } from '../../helpers/legacy-process-batch.js';

function createMockLLMConfig() {
  return {
    primary: {
      name: 'mock',
      apiKey: 'test-key',
      model: 'claude-3-opus-20240229',
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: 30_000,
      apiFormat: 'anthropic' as const,
    },
    maxAttempts: 1,
    retryDelayMs: 100,
    events: { emit: () => {} },
  };
}

function makeDrainResult(injected: Message[]) {
  return {
    injected,
    sources: injected.map(m => ({
      text: typeof m.content === 'string' ? m.content : '[content]',
      type: 'user_chat',
    })),
    count: injected.length,
    infos: [] as any[],
    addressedHandles: [] as any[],
  };
}

class ReadStateTestRuntime extends Runtime {
  public drainResult = makeDrainResult([]);

  protected override async _drainOwnInbox() {
    return this.drainResult;
  }
}

describe('Runtime read-state step boundary (Phase 1229 Step A)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-read-state-${randomUUID()}`);
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
    const runtime = new ReadStateTestRuntime({
      clawId: 'test-claw',
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
      idleTimeoutMs: 0,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    return runtime as ReadStateTestRuntime;
  }

  it('onStepComplete saves dialog before persisting read-state', async () => {
    const runtime = await makeRuntime();
    const sessionManager = (runtime as any).sessionManager;
    const saveSpy = vi.spyOn(sessionManager, 'save').mockResolvedValue(undefined);
    const persistSpy = vi.spyOn(persistModule, 'persistReadFileState').mockResolvedValue(undefined);

    let capturedOnStepComplete: ((stepCount: number) => Promise<void>) | undefined;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      capturedOnStepComplete = options.onStepComplete;
      await options.onStepComplete(1);
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);
    await runLegacyBatch(runtime);

    expect(capturedOnStepComplete).toBeDefined();
    expect(saveSpy).toHaveBeenCalled();
    expect(persistSpy).toHaveBeenCalledWith((runtime as any).execContext);
    expect(saveSpy.mock.invocationCallOrder[0]).toBeLessThan(
      persistSpy.mock.invocationCallOrder[0],
    );
  });

  it('read-state persist awaits dialog save (barrier)', async () => {
    const runtime = await makeRuntime();
    const sessionManager = (runtime as any).sessionManager;

    // The first save call is the turn-begin snapshot in _processTurnImpl and must resolve
    // so the step can reach onStepComplete. The second save call is inside onStepComplete
    // and is the one we defer to prove ordering.
    let saveCallCount = 0;
    let saveResolve: (() => void) | undefined;
    const saveDeferred = new Promise<void>((resolve) => { saveResolve = resolve; });
    vi.spyOn(sessionManager, 'save').mockImplementation(async (...args: any[]) => {
      saveCallCount++;
      if (saveCallCount === 2) {
        // onStepComplete's dialog save: block until the test releases it.
        await saveDeferred;
      }
    });

    let capturedOnStepComplete: ((stepCount: number) => Promise<void>) | undefined;
    vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      capturedOnStepComplete = options.onStepComplete;
      // Return without awaiting onStepComplete so the test can inspect the barrier.
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);
    const batchPromise = runLegacyBatch(runtime);

    await vi.waitUntil(() => capturedOnStepComplete !== undefined, { timeout: 1000 });
    const stepPromise = capturedOnStepComplete!(1);

    // Persist must not run until dialog save settles.
    const fileExistsBefore = await fs.access(path.join(testClawDir, READ_STATE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(fileExistsBefore).toBe(false);

    saveResolve!();
    await stepPromise;
    await batchPromise;

    // After the barrier, the real persistence primitive wrote the file.
    const fileExistsAfter = await fs.access(path.join(testClawDir, READ_STATE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(fileExistsAfter).toBe(true);
  });

  it('persist failure is not swallowed by Runtime', async () => {
    const runtime = await makeRuntime();
    const persistError = new Error('disk full');
    vi.spyOn(persistModule, 'persistReadFileState').mockRejectedValue(persistError);

    vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      await options.onStepComplete(1);
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);
    await expect(runLegacyBatch(runtime)).rejects.toThrow('disk full');
  });

  it('parallel tool reads aggregate into a single step snapshot', async () => {
    const runtime = await makeRuntime();
    const persistSpy = vi.spyOn(persistModule, 'persistReadFileState').mockResolvedValue(undefined);

    vi.spyOn(loopModule, 'runReact').mockImplementation(async (options) => {
      // Simulate parallel readonly tool calls updating the same Map.
      (runtime as any).execContext.readFileState.set('x.md', {
        hash: 'hx', timestamp: 1, isFullRead: true,
      });
      (runtime as any).execContext.readFileState.set('y.md', {
        hash: 'hy', timestamp: 2, isFullRead: true,
      });
      await options.onStepComplete(1);
      return { finalText: 'ok', stepsUsed: 1, stopReason: 'end_turn' } as ReactResult;
    });

    runtime.drainResult = makeDrainResult([{ role: 'user', content: 'hi' } as Message]);
    await runLegacyBatch(runtime);

    // One persist call commits the aggregated state of the whole step.
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        readFileState: expect.objectContaining({ size: 2 }),
      }),
    );
  });
});
