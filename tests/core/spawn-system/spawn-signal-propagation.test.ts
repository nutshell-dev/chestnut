/**
 * spawn signal propagation tests (phase 874)
 *
 * Coverage:
 * - outer abort signal propagates to inner runSubagent (spawn-system/system.ts)
 * - pre-aborted signal boundary path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { spawnTool } from '../../../src/core/spawn-system/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

vi.mock('../../../src/core/subagent/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/subagent/index.js')>();
  return {
    ...mod,
    runSubagent: mockRunSubagent,
  };
});

describe('spawn signal propagation (phase 874)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;

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
    mockRunSubagent.mockClear();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('propagates ctx.signal to runSubagent on sync path', async () => {
    const outerController = new AbortController();
    mockRunSubagent.mockResolvedValue({ text: 'ok' });

    const ctxWithSignal = makeBaseCtx(outerController.signal);
    const result = await spawnTool.execute({ intent: 'test signal', async: false }, ctxWithSignal);

    expect(result.success).toBe(true);
    expect(mockRunSubagent).toHaveBeenCalledOnce();
    const callArgs = mockRunSubagent.mock.calls[0][0];
    expect(callArgs.signal).toBe(outerController.signal);
  });

  it('pre-aborted signal propagates to runSubagent and returns failure', async () => {
    const outerController = new AbortController();
    outerController.abort();
    mockRunSubagent.mockRejectedValue(new Error('aborted'));

    const ctxPreAborted = makeBaseCtx(outerController.signal);
    const result = await spawnTool.execute({ intent: 'pre-aborted', async: false }, ctxPreAborted);

    expect(result.success).toBe(false);
    expect(mockRunSubagent).toHaveBeenCalledOnce();
    const callArgs = mockRunSubagent.mock.calls[0][0];
    expect(callArgs.signal).toBe(outerController.signal);
  });
});
