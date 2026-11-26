import { describe, expect, it, vi } from 'vitest';
import { runShadow } from '../../../src/core/shadow-system/system.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { createDoneTool, DONE_TOOL_NAME } from '../../../src/core/subagent/tools/done.js';
import type { Tool } from '../../../src/foundation/tools/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { completedOutcome, executionIdentity, executionRef } from './execution-fixtures.js';

const readTool: Tool = {
  name: 'read', description: 'read', schema: { type: 'object', properties: {} },
  profiles: ['full'], readonly: true, idempotent: true,
  execute: async () => ({ success: true, content: 'ok' }),
};

function setup() {
  const registry = new ToolRegistryImpl();
  registry.register(readTool);
  registry.register(createDoneTool());
  const manifest = registry.freeze();
  const audit = { write: vi.fn(), message: (value: string) => value, preview: (value: string) => value } as any;
  const ctx = new ExecContextImpl({
    clawId: 'parent', clawDir: '/tmp', profile: 'full', fs: {} as FileSystem,
    registry, baseRegistry: registry, llm: {} as LLMOrchestrator,
    auditWriter: audit, currentToolUseId: 'tu-parent' as any,
    execution: { callerKind: 'main', allowShadow: true },
  });
  return { registry, manifest, ctx };
}

describe('shadow static parent snapshot equivalence', () => {
  it('reuses prompt, canonical tools/revision and only appends the instruction message', async () => {
    const { registry, manifest, ctx } = setup();
    const tools = registry.formatForLLM(manifest);
    const mainMessages = [{ role: 'user' as const, content: 'parent request' }];
    const start = vi.fn().mockImplementation(async request => {
      const identity = executionIdentity(request);
      return executionRef(identity, Promise.resolve(completedOutcome(identity, 'shadow result')));
    });

    const result = await runShadow({
      task: 'branch task', ctx, mainMessages,
      turnSnapshot: {
        systemPrompt: 'static parent prompt', tools, messages: mainMessages,
        manifestRevision: manifest.revision, promptRevision: 'prompt-revision',
      },
      subagentRunner: { start },
    });

    expect(result.success).toBe(true);
    const call = start.mock.calls[0][0];
    const explicitInput = call.input;
    expect(explicitInput.systemPrompt).toEqual({ kind: 'text', text: 'static parent prompt' });
    expect(explicitInput.tools.manifest.llmTools).toEqual(tools);
    expect(explicitInput.tools.manifest.llmTools).not.toBe(tools);
    expect(explicitInput.messages?.slice(0, -1)).toEqual(mainMessages);
    expect(explicitInput.messages).toHaveLength(mainMessages.length + 1);
    expect(explicitInput.execution).toMatchObject({
      callerKind: 'shadow', allowDone: true, allowShadow: false,
      allowSummon: false, allowNotifyClaw: false, manifestRevision: manifest.revision,
    });
    expect(explicitInput.tools.manifest.revision).toBe(manifest.revision);
    expect(explicitInput.resultCapture).toEqual({ toolName: DONE_TOOL_NAME });
    expect(call.runId).toMatch(/^shadow-/);
    expect(call.resultDir).toBe(`tasks/sync/shadow/${call.runId}`);
    expect(result.metadata).toMatchObject({
      manifestRevision: manifest.revision, promptRevision: 'prompt-revision',
    });
  });

  it('fails on revision mismatch without running a subagent or rebuilding tools', async () => {
    const { registry, manifest, ctx } = setup();
    const start = vi.fn();
    const result = await runShadow({
      task: 'branch task', ctx, mainMessages: [],
      turnSnapshot: {
        systemPrompt: 'static parent prompt', tools: registry.formatForLLM(manifest),
        messages: [], manifestRevision: 'not-the-parent-revision', promptRevision: 'p',
      },
      subagentRunner: { start },
    });

    expect(result).toMatchObject({ success: false, error: 'shadow_manifest_revision_mismatch' });
    expect(start).not.toHaveBeenCalled();
  });

  it('fails explicitly when the parent snapshot is missing', async () => {
    const { ctx } = setup();
    const start = vi.fn();
    const result = await runShadow({ task: 'branch task', ctx, subagentRunner: { start } });
    expect(result).toMatchObject({ success: false, error: 'no_main_context' });
    expect(start).not.toHaveBeenCalled();
  });
});
