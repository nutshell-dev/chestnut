import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import {
  captureCurrentProcessRef,
  type ProcessRefObservation,
} from '../../../src/foundation/process-exec/index.js';
import {
  type LLMCallOptions,
  type LLMOrchestrator,
  type LLMStreamChunk,
} from '../../../src/foundation/llm-orchestrator/index.js';
import { llmProviderProtocol } from '../../../src/foundation/llm-provider/index.js';
import { type Tool, type ToolResult } from '../../../src/foundation/tools/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import {
  createDefaultSubagentExecutionRunner,
  createSubagentExecutionRunner,
  prepareSubagentInput,
  type SubagentExecutionDriver,
  type SubagentExecutionInfrastructure,
} from '../../../src/core/subagent/index.js';
import {
  createSubAgentRecoveryStore,
  RecoveryUncertainSideEffectError,
} from '../../../src/core/subagent/recovery-state.js';
import type { CompleteLLMResponse } from '../../../src/core/step-executor/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const { makeToolUseId } = llmProviderProtocol;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function textChunks(text: string): LLMStreamChunk[] {
  return [
    { type: 'text_delta', delta: text },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

function fakeLlm(scripts: readonly (readonly LLMStreamChunk[] | Error)[]) {
  let calls = 0;
  const requests: LLMCallOptions[] = [];
  const stream = vi.fn((options: LLMCallOptions): AsyncIterableIterator<LLMStreamChunk> => {
    requests.push(options);
    const script = scripts[calls++];
    if (!script) throw new Error(`controlled restart LLM has no response for call ${calls}`);
    return (async function* () {
      if (script instanceof Error) throw script;
      for (const chunk of script) yield chunk;
    })();
  });
  const llm = {
    stream,
    call: vi.fn(), healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'controlled', model: 'controlled', isFallback: false })),
    getFailureDisposition: vi.fn(() => 'unknown' as const),
    close: vi.fn(async () => {}), reloadConfig: vi.fn(),
  } as unknown as LLMOrchestrator;
  return { llm, requests, calls: () => calls };
}

function tool(name: string, execute: Tool['execute']): Tool {
  return {
    name, description: 'restart composition tool',
    schema: { type: 'object', properties: { value: { type: 'number' } } },
    readonly: false, idempotent: false, profiles: ['subagent'], execute,
  };
}

function completeResponse(): CompleteLLMResponse {
  return {
    response: {
      content: [{ type: 'tool_use', id: makeToolUseId('toolu_restart'), name: 'restart_tool', input: { value: 1 } }],
      stop_reason: 'tool_use',
    },
    llmInfo: { model: 'controlled', inputTokens: 1, outputTokens: 1, latencyMs: 1 },
    committedAtMs: Date.now(),
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupTempDir));
});

async function fixture(tag: string, executionTool?: Tool) {
  const root = await createTrackedTempDir(`chestnut-phase2248-restart-${tag}-`);
  tempDirs.push(root);
  const fs = new NodeFileSystem({ baseDir: root });
  const registry = new ToolRegistryImpl();
  if (executionTool) registry.register(executionTool);
  const input = prepareSubagentInput({
    prompt: 'restart from committed owner facts', tools: { manifest: registry.freeze() },
    budget: { timeoutMs: 5_000, maxSteps: 3 },
  });
  const infrastructure = (llm: LLMOrchestrator): SubagentExecutionInfrastructure => ({
    clawDir: root, syncDir: path.join(root, 'tasks/sync'), fs, llm, registry,
  });
  return { root, fs, registry, input, infrastructure };
}

function processEvidence() {
  const captured = captureCurrentProcessRef();
  if (captured.kind !== 'captured') throw new Error('test host ProcessRef capture unavailable');
  return captured.evidence;
}

function processInspection(kind: 'alive' | 'gone' | 'unknown') {
  return {
    captureCurrentProcessRef,
    inspectProcessRef: (): ProcessRefObservation => kind === 'alive'
      ? { kind, evidence: processEvidence() }
      : { kind, reason: kind === 'gone' ? 'absent' : 'query_failed', evidence: processEvidence() },
  };
}

describe('Phase 2248 K persistent restart composition', () => {
  it('V04/V05: open is read-only and explicit resume preserves a started tool as uncertain without LLM/tool replay', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ success: true, content: 'must not replay' }));
    const { fs, input, infrastructure } = await fixture('uncertain', tool('restart_tool', execute));
    const firstLlm = fakeLlm([new RecoveryUncertainSideEffectError('toolu_restart')]);
    const firstRunner = createDefaultSubagentExecutionRunner(infrastructure(firstLlm.llm));
    const first = await firstRunner.start({
      runId: 'restart-uncertain', resultDir: 'results/restart-uncertain', input,
      deadlineAtMs: Date.now() + 5_000,
    });
    await expect(first.completion).resolves.toMatchObject({ kind: 'failed', recovery: 'uncertain_side_effect' });
    expect(firstLlm.calls()).toBe(1);

    const store = createSubAgentRecoveryStore({ fs, resultDir: first.identity.resultDir });
    await store.llmResponseCommitted(completeResponse());
    await store.toolStarted({
      toolUseId: makeToolUseId('toolu_restart'), toolName: 'restart_tool', input: { value: 1 }, startedAtMs: Date.now(),
    });
    const resumeLlm = fakeLlm([textChunks('must not request a fresh response')]);
    const restarted = createDefaultSubagentExecutionRunner(infrastructure(resumeLlm.llm));
    const opened = await restarted.open(first.identity);
    expect(opened.kind).toBe('found');
    expect(opened.kind === 'found' ? opened.owner : undefined).toBe('settled');
    expect(resumeLlm.calls()).toBe(0);
    expect(execute).not.toHaveBeenCalled();

    const resumed = await restarted.resume({
      runId: first.identity.runId, resultDir: first.identity.resultDir, input,
      previousAttemptId: first.identity.attemptId, deadlineAtMs: Date.now() + 60_000,
    });
    const outcome = await resumed.completion;
    expect(outcome).toMatchObject({ kind: 'failed', recovery: 'uncertain_side_effect' });
    expect(outcome.cause).toBeInstanceOf(RecoveryUncertainSideEffectError);
    expect(resumeLlm.calls()).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(resumed.identity.attemptId).not.toBe(first.identity.attemptId);
    expect(JSON.parse(await fs.read(`${first.identity.resultDir}/execution/attempts/2/claim.json`))).toMatchObject({
      parentAttemptId: first.identity.attemptId,
      startBasis: { kind: 'resume', previousAttemptId: first.identity.attemptId },
      deadlineAtMs: JSON.parse(await fs.read(`${first.identity.resultDir}/execution/attempts/1/claim.json`)).deadlineAtMs,
    });
    expect(JSON.parse(await fs.read(`${first.identity.resultDir}/recovery/cursor.json`))).toMatchObject({
      kind: 'awaiting-tools', startedToolIds: ['toolu_restart'],
    });
  });

  it('V04: a committed response with a provably unstarted tool resumes once and requests only the following LLM turn', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ success: true, content: 'executed exactly once' }));
    const { fs, input, infrastructure } = await fixture('unstarted', tool('restart_tool', execute));
    const firstLlm = fakeLlm([new Error('initial attempt stopped before the tool response')]);
    const first = await createDefaultSubagentExecutionRunner(infrastructure(firstLlm.llm)).start({
      runId: 'restart-unstarted', resultDir: 'results/restart-unstarted', input,
      deadlineAtMs: Date.now() + 5_000,
    });
    await expect(first.completion).resolves.toMatchObject({ kind: 'failed' });
    await createSubAgentRecoveryStore({ fs, resultDir: first.identity.resultDir }).llmResponseCommitted(completeResponse());
    expect(JSON.parse(await fs.read(`${first.identity.resultDir}/recovery/cursor.json`))).toMatchObject({
      kind: 'awaiting-tools', startedToolIds: [],
    });

    const resumeLlm = fakeLlm([textChunks('resumed final response')]);
    const restarted = createDefaultSubagentExecutionRunner(infrastructure(resumeLlm.llm));
    const before = await restarted.open(first.identity);
    expect(before.kind).toBe('found');
    expect(execute).not.toHaveBeenCalled();
    expect(resumeLlm.calls()).toBe(0);

    const resumed = await restarted.resume({
      runId: first.identity.runId, resultDir: first.identity.resultDir, input,
      previousAttemptId: first.identity.attemptId,
    });
    await expect(resumed.completion).resolves.toMatchObject({ kind: 'completed', content: 'resumed final response' });
    expect(execute.mock.calls, JSON.stringify(resumeLlm.requests)).toHaveLength(1);
    expect(resumeLlm.calls()).toBe(1);
    expect(await fs.exists(`${first.identity.resultDir}/execution/attempts/3/claim.json`)).toBe(false);
  });

  it('V05: alive/unknown owners cannot be taken over and competing explicit resumes execute one successor', async () => {
    const { fs } = await fixture('owners');
    const releaseFirst = deferred();
    const createFirst = vi.fn<SubagentExecutionDriver['createAttempt']>(() => ({
      completion: releaseFirst.promise.then(() => ({ content: 'original owner settled' })), close: () => {},
    }));
    const location = { runId: 'restart-owner', resultDir: 'results/restart-owner', input: { prompt: 'owner admission' } };
    const alive = createSubagentExecutionRunner({
      fs, process: processInspection('alive'), driver: { createAttempt: createFirst },
    });
    const first = await alive.start(location);
    await vi.waitFor(() => expect(createFirst).toHaveBeenCalledTimes(1));
    const unknown = createSubagentExecutionRunner({
      fs, process: processInspection('unknown'), driver: { createAttempt: createFirst },
    });
    expect(await unknown.open(first.identity)).toMatchObject({ kind: 'owner_unavailable' });
    await expect(alive.resume({ ...location, previousAttemptId: first.identity.attemptId }))
      .rejects.toMatchObject({ kind: 'owner_unavailable' });
    await expect(unknown.resume({ ...location, previousAttemptId: first.identity.attemptId }))
      .rejects.toMatchObject({ kind: 'owner_unavailable' });
    expect(await fs.exists(`${first.identity.resultDir}/execution/attempts/2/claim.json`)).toBe(false);

    releaseFirst.resolve();
    await expect(first.completion).resolves.toMatchObject({ kind: 'completed' });
    const createSuccessor = vi.fn<SubagentExecutionDriver['createAttempt']>(() => ({
      completion: Promise.resolve({ content: 'single successor' }), close: () => {},
    }));
    const successorOptions = { fs, process: processInspection('gone'), driver: { createAttempt: createSuccessor } };
    const [left, right] = await Promise.all([
      createSubagentExecutionRunner(successorOptions).resume({ ...location, previousAttemptId: first.identity.attemptId }),
      createSubagentExecutionRunner(successorOptions).resume({ ...location, previousAttemptId: first.identity.attemptId }),
    ]);
    expect(left).toBe(right);
    await expect(left.completion).resolves.toMatchObject({ kind: 'completed', content: 'single successor' });
    expect(createSuccessor).toHaveBeenCalledTimes(1);
    expect(await fs.exists(`${first.identity.resultDir}/execution/attempts/3/claim.json`)).toBe(false);
  });
});
