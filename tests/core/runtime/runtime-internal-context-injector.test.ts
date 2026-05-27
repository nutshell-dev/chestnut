/**
 * Runtime internal ContextInjector + ExecContext self-construction tests — phase 1211
 *
 * Covers:
 * - Runtime.initialize() self-constructs ContextInjector from deps.skillRegistry + deps.contractManager + systemFs + auditWriter
 * - Runtime.initialize() self-constructs ExecContext with correct clawId/clawDir/profile/fs/llm/maxSteps
 * - Registry + mainDialogStore lazy-injected into execContext (phase 766/768 regression guard)
 * - No external inject required for contextInjector / execContext
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { LLMOrchestratorConfig } from '../../../../src/foundation/llm-orchestrator/types.js';
import { TEST_LLM_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

function createMockLLMConfig(): LLMOrchestratorConfig {
  return {
    primary: {
      name: 'mock',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: TEST_LLM_TIMEOUT_MS,
      apiFormat: 'anthropic' as const,
    },
    maxAttempts: 1,
    retryDelayMs: 100,
  };
}

describe('Runtime internal ContextInjector + ExecContext self-construction (phase 1211)', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: Runtime[] = [];

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `claw-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => {});
    }
    await cleanupTempDir(tempDir);
  });

  it('initializes contextInjector internally from deps.skillRegistry + contractManager + systemFs + auditWriter', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    await runtime.initialize();

    // contextInjector is constructed internally, not from deps
    expect((runtime as unknown as { contextInjector: unknown }).contextInjector).toBeDefined();
    // Should be able to call buildSystemPromptForRegime (needs skillRegistry + contractManager wired)
    const result = await (runtime as unknown as { contextInjector: { buildSystemPromptForRegime: () => Promise<{ full: string; identityContent: string }> } }).contextInjector.buildSystemPromptForRegime();
    expect(typeof result.full).toBe('string');
    expect(typeof result.identityContent).toBe('string');
  });

  it('initializes execContext internally with correct clawId / clawDir / profile / maxSteps', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    await runtime.initialize();

    const execCtx = (runtime as unknown as { execContext: { clawId: string; clawDir: string; profile: string; maxSteps: number } }).execContext;
    expect(execCtx.clawId).toBe('test-claw');
    expect(execCtx.clawDir).toBe(clawDir);
    expect(execCtx.profile).toBe('full');
    expect(execCtx.maxSteps).toBe(1000); // DEFAULT_MAX_STEPS
  });

  it('lazy-injects registry and mainDialogStore into execContext after initialize (phase 766/768)', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    await runtime.initialize();

    const execCtx = (runtime as unknown as { execContext: { registry?: unknown; mainDialogStore?: unknown } }).execContext;
    expect(execCtx.registry).toBeDefined();
    expect(execCtx.mainDialogStore).toBeDefined();
  });

  it('does not require contextInjector or execContext in RuntimeDependencies (phase 1211 wire cleanup)', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });

    // Verify deps has no contextInjector / execContext (they were removed from RuntimeDependencies)
    expect('contextInjector' in deps).toBe(false);
    expect('execContext' in deps).toBe(false);

    // Runtime should still initialize fine
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    await expect(runtime.initialize()).resolves.not.toThrow();
  });
});
