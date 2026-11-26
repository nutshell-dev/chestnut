/**
 * spawn signal propagation tests (phase 874)
 *
 * Coverage:
 * - outer abort signal propagates to SubAgent runner.start (spawn-system/system.ts)
 * - pre-aborted signal boundary path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createSpawnTool } from '../../../src/core/spawn-system/tools/spawn.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { SubagentFinalOutcome } from '../../../src/core/subagent/index.js';
import { completedOutcome, deferred, executionIdentity, executionRef, terminalFailure } from './execution-fixtures.js';

const { mockStartSubagent } = vi.hoisted(() => ({
  mockStartSubagent: vi.fn(),
}));

describe('spawn signal propagation (phase 874)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  const testSpawnTool = createSpawnTool({ subagentRunner: { start: mockStartSubagent } });

  function completeSync(text: string): void {
    mockStartSubagent.mockImplementation(async request => {
      const identity = executionIdentity(request);
      return executionRef(identity, Promise.resolve(completedOutcome(identity, text)));
    });
  }

  function makeRegistry(): ToolRegistryImpl {
    const registry = new ToolRegistryImpl();
    registry.register({
      name: 'read',
      description: 'read',
      schema: { type: 'object', properties: {} },
      readonly: true,
      idempotent: true,
      execute: vi.fn(),
    });
    registry.register({
      name: 'done',
      description: 'done',
      schema: { type: 'object', properties: {} },
      readonly: false,
      idempotent: false,
      execute: vi.fn(),
    });
    return registry;
  }

  function makeLLM(): LLMOrchestrator {
    return {
      call: vi.fn(),
      stream: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getProviderInfo: vi.fn().mockReturnValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as LLMOrchestrator;
  }

  function makeBaseCtx(signal?: AbortSignal): ExecContextImpl {
    return new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs,
      auditWriter: audit.audit,
      llm: makeLLM(),
      registry: makeRegistry(),
      signal,
    });
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    mockStartSubagent.mockReset();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('propagates ctx.signal to runner.start on sync path', async () => {
    const outerController = new AbortController();
    completeSync('ok');

    const ctxWithSignal = makeBaseCtx(outerController.signal);
    const result = await testSpawnTool.execute({ intent: 'test signal', async: false }, ctxWithSignal);

    expect(result.success).toBe(true);
    expect(mockStartSubagent).toHaveBeenCalledOnce();
    const callArgs = mockStartSubagent.mock.calls[0][0];
    expect(callArgs.signal).toBe(outerController.signal);
  });

  it('pre-aborted signal propagates to runner.start and returns failure', async () => {
    const outerController = new AbortController();
    outerController.abort();
    mockStartSubagent.mockRejectedValue(new Error('aborted'));

    const ctxPreAborted = makeBaseCtx(outerController.signal);
    const result = await testSpawnTool.execute({ intent: 'pre-aborted', async: false }, ctxPreAborted);

    expect(result.success).toBe(false);
    expect(mockStartSubagent).toHaveBeenCalledOnce();
    const callArgs = mockStartSubagent.mock.calls[0][0];
    expect(callArgs.signal).toBe(outerController.signal);
  });

  it('keeps waiting after stop receipt until the owner delivers the real interrupted outcome', async () => {
    const outerController = new AbortController();
    const completion = deferred<SubagentFinalOutcome>();
    const reason = { kind: 'user_stop' };
    const degraded = [{ stage: 'artifact' as const, artifact: 'dialog:write', error: 'late EIO' }];
    let identity: ReturnType<typeof executionIdentity> | undefined;
    let ref: ReturnType<typeof executionRef> | undefined;
    let stopReceipt: unknown;
    mockStartSubagent.mockImplementation(async request => {
      identity = executionIdentity(request);
      ref = executionRef(identity, completion.promise);
      vi.mocked(ref.requestStop).mockResolvedValue({
        identity,
        accepted: true,
        state: 'stopping',
        reason,
        persisted: true,
        durable: true,
        persistence: {
          path: `${identity.resultDir}/execution/attempts/1/stops/1.json`,
          kind: 'durable',
          persisted: true,
          durable: true,
        },
      });
      request.signal?.addEventListener('abort', () => {
        void ref?.requestStop(request.signal?.reason).then(receipt => { stopReceipt = receipt; });
      }, { once: true });
      return ref;
    });

    let settled = 0;
    const pending = testSpawnTool.execute(
      { intent: 'gated cancellation', async: false },
      makeBaseCtx(outerController.signal),
    ).then(result => { settled += 1; return result; });
    await vi.waitFor(() => { expect(mockStartSubagent).toHaveBeenCalledOnce(); });

    outerController.abort(reason);
    await vi.waitFor(() => { expect(stopReceipt).toMatchObject({ accepted: true, state: 'stopping' }); });
    expect(ref?.requestStop).toHaveBeenCalledOnce();
    expect(settled).toBe(0);

    if (!identity) throw new Error('test setup: execution identity was not returned');
    completion.resolve(terminalFailure(identity, 'interrupted', reason, degraded));
    const result = await pending;
    expect(settled).toBe(1);
    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({
      execution: identity,
      outcomeKind: 'interrupted',
      cause: reason,
      degraded,
    });
    expect(JSON.stringify(result)).not.toContain('completion');
  });
});
