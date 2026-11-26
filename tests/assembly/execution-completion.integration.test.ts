import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import {
  LLMAllProvidersFailedError,
  type LLMCallOptions,
  type LLMOrchestrator,
  type LLMStreamChunk,
} from '../../src/foundation/llm-orchestrator/index.js';
import {
  type Tool,
  type ToolResult,
} from '../../src/foundation/tools/index.js';
import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { TOOL_EXEC_CLEANUP_BUDGET_MS } from '../../src/foundation/tools/constants.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import {
  createDefaultSubagentExecutionRunner,
  prepareSubagentInput,
  projectSubagentResult,
  runSubagent,
  startSubagent,
  type RunSubagentOptions,
} from '../../src/core/subagent/index.js';
import { AsyncTaskSystem } from '../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../src/core/async-task-system/short-id-index.js';
import {
  LLM_WAIT_DEADLINE_FILE,
  LLM_WAIT_FILE,
} from '../../src/core/async-task-system/llm-wait-state.js';
import {
  makeFullTaskId,
  makeShortTaskId,
  type SubAgentTask,
} from '../../src/core/async-task-system/types.js';
import { runSpawnSync } from '../../src/core/spawn-system/system.js';
import { runContractVerifier } from '../../src/core/contract/verifier-job.js';
import { makeContractId } from '../../src/core/contract/types.js';
import { scanSubagentResults } from '../../src/cli/commands/subagent-helpers.js';
import { makeExecContext } from '../helpers/exec-context.js';
import { createMockWatcherFactory } from '../helpers/task-system.js';
import { makeMockAudit } from '../helpers/audit.js';
import { cleanupTempDir, createTrackedTempDir } from '../utils/temp.js';

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

function toolChunks(name: string, input: Record<string, unknown> = {}): LLMStreamChunk[] {
  return [
    { type: 'tool_use_start', toolUse: { id: `toolu_${name}`, name, partialInput: '' } },
    { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: JSON.stringify(input) } },
    { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

function fakeLlm(scripts: readonly (readonly LLMStreamChunk[] | Error)[]) {
  let calls = 0;
  const stream = vi.fn((_options: LLMCallOptions): AsyncIterableIterator<LLMStreamChunk> => {
    const script = scripts[calls++];
    if (!script) throw new Error(`controlled LLM has no response for call ${calls}`);
    return (async function* () {
      if (script instanceof Error) throw script;
      for (const chunk of script) yield chunk;
    })();
  });
  const llm = {
    stream,
    call: vi.fn(),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'controlled', model: 'controlled', isFallback: false })),
    getFailureDisposition: vi.fn(() => 'unknown' as const),
    close: vi.fn(async () => {}),
    reloadConfig: vi.fn(),
  } as unknown as LLMOrchestrator;
  return { llm, stream, calls: () => calls };
}

function gatedTool(name: string) {
  const entered = deferred();
  const release = deferred<ToolResult>();
  const execute = vi.fn(() => {
    entered.resolve();
    return release.promise;
  });
  const tool: Tool = {
    name,
    description: 'controlled non-cooperative execution gate',
    schema: { type: 'object', properties: {} },
    readonly: false,
    idempotent: false,
    profiles: ['full', 'subagent', 'readonly'],
    execute,
  };
  return { tool, entered: entered.promise, release: release.resolve, execute };
}

function audit(): AuditLog {
  return { write: vi.fn(), preview: String, message: String, summary: String };
}

function task(executionInput?: SubAgentTask['executionInput']): SubAgentTask {
  const id = randomUUID();
  return {
    kind: 'subagent', id: makeFullTaskId(id), shortId: makeShortTaskId(id.slice(0, 8)),
    intent: 'execute through the real owner', timeoutMs: 60_000, maxSteps: 3,
    parentClawId: 'parent', createdAt: new Date().toISOString(),
    ...(executionInput ? { executionInput } : {}),
  };
}

async function schedule(system: AsyncTaskSystem, item: SubAgentTask) {
  const { id, shortId: _shortId, createdAt, ...payload } = item;
  await system.schedulePrepared('subagent', { id: makeFullTaskId(id), createdAt, payload });
}

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map(cleanupTempDir));
});

async function fixture(tag: string) {
  const root = await createTrackedTempDir(`chestnut-phase2248-k-${tag}-`);
  tempDirs.push(root);
  return { root, fs: new NodeFileSystem({ baseDir: root }) };
}

function runOptions(
  root: string,
  fs: NodeFileSystem,
  llm: LLMOrchestrator,
  registry: ToolRegistryImpl,
  agentId: string,
  timeoutMs = 5_000,
): RunSubagentOptions {
  return {
    agentId, clawDir: root, fs, llm, registry,
    prompt: 'exercise the production execution chain', systemPrompt: 'controlled test system',
    resultDir: path.join(root, 'tasks/sync/spawn', agentId),
    syncDir: path.join(root, 'tasks/sync'), timeoutMs, maxSteps: 3,
  };
}

describe('Phase 2248 K execution delivery composition', () => {
  it('V01: Tools begin outlives cleanup and the real late body, timeout cause and journal converge on disk', async () => {
    const { root, fs } = await fixture('tools-late');
    const gate = gatedTool('noncooperative');
    const registry = new ToolRegistryImpl();
    registry.register(gate.tool);
    const ctx = makeExecContext({
      clawDir: root, workspaceDir: path.join(root, 'clawspace'),
      syncDir: path.join(root, 'tasks/sync'), fs,
    });
    const ref = await new ToolExecutorImpl(registry, 60_000).begin({
      toolName: 'noncooperative', args: {}, ctx, timeoutMs: 20,
    });
    await gate.entered;
    let settled = false;
    void ref.completion.then(() => { settled = true; });
    const views: string[] = [];
    ref.observe(view => { views.push(`${view.seq}:${view.state}:${view.cleanup ?? '-'}`); });

    await vi.waitFor(() => expect(views.at(-1)).toBe('2:stopping:pending'), {
      timeout: 20 + TOOL_EXEC_CLEANUP_BUDGET_MS + 500,
    });
    expect(views).toContain('1:stopping:-');
    expect(views.at(-1)).toBe('2:stopping:pending');
    expect(settled).toBe(false);
    expect((await fs.list('tasks/sync/tool-executions', { recursive: true })).length).toBeGreaterThan(0);

    const body = 'real late response body: 非合作工具最终正文';
    gate.release({ success: true, content: body });
    const final = await ref.completion;
    expect(final.actualResult).toEqual({ success: true, content: body });
    expect(final.presentation).toEqual({ kind: 'timeout', reason: { type: 'tool_timeout', ms: 20 } });
    expect(final.stopReason).toEqual({ type: 'tool_timeout', ms: 20 });
    expect(final.presentedResult.success).toBe(false);
    expect(final.presentedResult.content).toContain('execution limit');
    const journal = JSON.parse(await fs.read(final.persistence.final.path));
    expect(journal.actualResult).toEqual({ success: true, content: body });
    expect(journal.presentation.kind).toBe('timeout');
    expect(final.persistence.final).toMatchObject({ persisted: true, durable: true });
  });

  it('V03/V13: public start and stop return before convergence; CLI never promotes stopping to completed', async () => {
    const { root, fs } = await fixture('subagent-stop');
    const gate = gatedTool('held_step');
    const registry = new ToolRegistryImpl();
    registry.register(gate.tool);
    const controlled = fakeLlm([toolChunks('held_step'), textChunks('unreachable after stop')]);
    const opts = runOptions(root, fs, controlled.llm, registry, 'spawn-phase2248-stopping', 250);
    const ref = await startSubagent(opts);
    await gate.entered;
    let settled = false;
    void ref.completion.then(() => { settled = true; });
    // The internal SubAgent timeout reaches the real Tools owner first. Its
    // persisted stop intent is the convergence-independent observation point.
    await vi.waitFor(async () => {
      const entries = await fs.list('tasks/sync/tool-executions', { recursive: true });
      expect(entries.some(entry => entry.path.endsWith('/stop-1.json'))).toBe(true);
    });
    expect((await ref.read()).state).toBe('running');

    const receipt = await ref.requestStop({ type: 'test_cancel' });
    expect(receipt).toMatchObject({ accepted: true, state: 'stopping', persisted: true });
    expect(settled).toBe(false);
    expect(await fs.exists(`${ref.identity.resultDir}/execution/attempts/1/outcome.json`)).toBe(false);
    expect(await fs.exists(`${ref.identity.resultDir}/messages.json`)).toBe(false);
    expect(JSON.parse(await fs.read(`${ref.identity.resultDir}/recovery/cursor.json`))).toMatchObject({
      kind: 'awaiting-tools', startedToolIds: ['toolu_held_step'],
    });

    await fs.writeAtomic(`${ref.identity.resultDir}/result.txt`, 'stale result must not win');
    const stopping = await scanSubagentResults({ fsFactory: base => new NodeFileSystem({ baseDir: base }) }, root);
    expect(stopping).toHaveLength(1);
    expect(stopping[0]).toMatchObject({ id: opts.agentId, status: 'stopping', source: 'execution' });

    gate.release({ success: true, content: 'actual gated tool body' });
    const outcome = await ref.completion;
    expect(outcome.kind).toBe('interrupted');
    expect(outcome.cause).toMatchObject({ name: 'ToolTimeoutError' });
    expect(settled).toBe(true);
    expect(await fs.exists(`${ref.identity.resultDir}/execution/attempts/1/outcome.json`)).toBe(true);
    const terminal = await scanSubagentResults({ fsFactory: base => new NodeFileSystem({ baseDir: base }) }, root);
    expect(terminal[0]).toMatchObject({ status: 'interrupted', state: 'settled', source: 'execution' });
    expect(controlled.calls()).toBe(1);
  });

  it('V05/V14: duplicate public starts, read-only open and runSubagent share one gated lifecycle', async () => {
    const { root, fs } = await fixture('public-duplicate');
    const gate = gatedTool('once_only');
    const registry = new ToolRegistryImpl();
    registry.register(gate.tool);
    const controlled = fakeLlm([toolChunks('once_only'), textChunks('one real final response')]);
    const opts = runOptions(root, fs, controlled.llm, registry, 'spawn-phase2248-duplicate');
    const first = await startSubagent(opts);
    await gate.entered;
    const duplicate = await startSubagent(opts);
    expect(duplicate).toBe(first);

    const runner = createDefaultSubagentExecutionRunner({
      clawDir: root, syncDir: path.join(root, 'tasks/sync'), fs, llm: controlled.llm, registry,
    });
    const opened = await runner.open(first.identity);
    expect(opened.kind).toBe('found');
    expect(opened.kind === 'found' && opened.ref).not.toHaveProperty('requestStop');
    await expect(startSubagent({ ...opts, prompt: 'different input' })).rejects.toMatchObject({ kind: 'conflict' });
    expect(gate.execute).toHaveBeenCalledTimes(1);

    let convenienceSettled = false;
    const convenience = runSubagent(opts).then(result => { convenienceSettled = true; return result; });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(convenienceSettled).toBe(false);
    gate.release({ success: true, content: 'gate completed once' });

    const [outcome, projected] = await Promise.all([first.completion, convenience]);
    expect(outcome).toMatchObject({ kind: 'completed', content: 'one real final response' });
    expect(projected).toEqual(projectSubagentResult(outcome));
    expect(gate.execute).toHaveBeenCalledTimes(1);
    expect(controlled.calls()).toBe(2);
    expect(await fs.exists(`${first.identity.resultDir}/execution/attempts/2/claim.json`)).toBe(false);
  });

  it('V07: ATS cancellation retains the real slot and emits exactly one terminal delivery after release', async () => {
    const { root, fs } = await fixture('ats-cancel');
    const gate = gatedTool('ats_gate');
    const registry = new ToolRegistryImpl();
    registry.register(gate.tool);
    const controlled = fakeLlm([toolChunks('ats_gate'), textChunks('unreachable cancelled final')]);
    const execution = createDefaultSubagentExecutionRunner({
      clawDir: root, syncDir: path.join(root, 'tasks/sync'), fs, llm: controlled.llm, registry,
    });
    const input = prepareSubagentInput({
      prompt: 'ATS cancellation composition', tools: { manifest: registry.freeze() },
      budget: { timeoutMs: 60_000, maxSteps: 3 },
    });
    const item = task({ schema_version: 1, input });
    const deliver = vi.fn(async () => ({ kind: 'delivered' as const }));
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry,
      fsFactory: () => fs, execution, deliverySink: { deliver },
      createWatcher: createMockWatcherFactory(fs).factory,
    });
    await system.initialize();
    await schedule(system, item);
    await system.startDispatch();
    await gate.entered;
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(1));

    // The real SubAgent stop receipt persists asynchronously before ATS installs
    // its bounded wait. Use that production budget rather than racing fake timers
    // against the stop-intent disk write.
    const cancelled = await system.cancelDetailed(item.id);
    expect(cancelled).toMatchObject({ kind: 'running_cancelled', settle: { kind: 'timeout' }, terminal: 'not_observed' });
    expect(system.getInProcessRunningCount()).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(await fs.exists(`tasks/queues/failed/${item.id}.json`)).toBe(false);
    expect(await fs.exists(`tasks/queues/results/${item.id}/execution/attempts/1/outcome.json`)).toBe(false);

    gate.release({ success: true, content: 'ATS gate really settled' });
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(0));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await fs.exists(`tasks/queues/failed/${item.id}.json`)).toBe(true);
    expect(await fs.exists(`tasks/queues/results/${item.id}/execution/attempts/1/outcome.json`)).toBe(true);
    expect(gate.execute).toHaveBeenCalledTimes(1);
    await system.shutdown(1);
  });

  it('V08: a real shared-dependency outcome creates bounded ATS waiting with the same execution identity', async () => {
    const { root, fs } = await fixture('ats-waiting');
    const registry = new ToolRegistryImpl();
    const failure = new LLMAllProvidersFailedError([{ provider: 'controlled', error: new Error('controlled outage') }]);
    const controlled = fakeLlm([failure]);
    const execution = createDefaultSubagentExecutionRunner({
      clawDir: root, syncDir: path.join(root, 'tasks/sync'), fs, llm: controlled.llm, registry,
    });
    const input = prepareSubagentInput({
      prompt: 'shared dependency composition', tools: { manifest: registry.freeze() },
      budget: { timeoutMs: 60_000, maxSteps: 1 },
    });
    const item = task({ schema_version: 1, input });
    const nextProbeAt = Date.now() + 30_000;
    const getSharedRecoveryDecision = vi.fn(() => ({ kind: 'at' as const, nextProbeAt }));
    const deliver = vi.fn();
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry,
      fsFactory: () => fs, execution, sharedRecovery: { getSharedRecoveryDecision },
      deliverySink: { deliver }, createWatcher: createMockWatcherFactory(fs).factory,
    });
    await system.initialize();
    await schedule(system, item);
    await system.startDispatch();
    await vi.waitFor(() => expect(controlled.calls()).toBe(1));
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(0));

    expect(getSharedRecoveryDecision).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    const wait = JSON.parse(await fs.read(`tasks/queues/results/${item.id}/${LLM_WAIT_FILE}`));
    expect(wait).toMatchObject({
      nextProbeAt, reason: expect.stringContaining('controlled outage'),
      execution: { runId: item.id, resultDir: `tasks/queues/results/${item.id}` },
    });
    const deadline = JSON.parse(await fs.read(`tasks/queues/results/${item.id}/${LLM_WAIT_DEADLINE_FILE}`));
    expect(deadline.expiresAt).toBe(wait.recordedAt + item.timeoutMs);
    expect(wait.expiresAt).toBe(deadline.expiresAt);
    expect(await fs.exists(`tasks/queues/failed/${item.id}.json`)).toBe(false);
    await system.shutdown(1);
  });

  it('V09: ordinary legacy input is migrated without rewriting its task/claim and then executed by the real owner', async () => {
    const { root, fs } = await fixture('legacy-input');
    const registry = new ToolRegistryImpl();
    const controlled = fakeLlm([textChunks('legacy executed through prepared input')]);
    const execution = createDefaultSubagentExecutionRunner({
      clawDir: root, syncDir: path.join(root, 'tasks/sync'), fs, llm: controlled.llm, registry,
    });
    const item = task();
    item.intent = 'legacy original prompt';
    item.systemPrompt = 'legacy original system';
    const deliver = vi.fn(async () => ({ kind: 'delivered' as const }));
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry,
      fsFactory: () => fs, execution, deliverySink: { deliver },
      prepareLegacyInput: declaration => prepareSubagentInput({
        ...declaration, tools: { manifest: registry.freeze() },
      }),
      createWatcher: createMockWatcherFactory(fs).factory,
    });
    await schedule(system, item);
    const taskPath = `tasks/queues/pending/${item.id}.json`;
    const claimPath = `tasks/queues/claims/${item.id}.json`;
    const taskBefore = await fs.read(taskPath);
    const claimBefore = await fs.read(claimPath);

    await system.initialize();
    expect(await fs.read(taskPath)).toBe(taskBefore);
    expect(await fs.read(claimPath)).toBe(claimBefore);
    const sidecar = JSON.parse(await fs.read(`tasks/queues/results/${item.id}/execution-input.json`));
    expect(sidecar).toMatchObject({ migrationSource: 'ordinary_legacy', input: { prompt: item.intent } });

    await system.startDispatch();
    await vi.waitFor(() => expect(controlled.calls()).toBe(1));
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(0));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await fs.exists(`tasks/queues/done/${item.id}.json`)).toBe(true);
    expect(JSON.parse(await fs.read(`tasks/queues/results/${item.id}/execution/attempts/1/outcome.json`))).toMatchObject({
      kind: 'completed', content: 'legacy executed through prepared input',
    });
    await system.shutdown(1);
  });

  it('V10: synchronous Spawn waits for the actual default owner result instead of a receipt', async () => {
    const { root, fs } = await fixture('spawn-direct');
    const registry = new ToolRegistryImpl();
    const controlled = fakeLlm([textChunks('direct spawn final body')]);
    const execution = createDefaultSubagentExecutionRunner({
      clawDir: root, syncDir: path.join(root, 'tasks/sync'), fs, llm: controlled.llm, registry,
    });
    const ctx = makeExecContext({
      clawDir: root, workspaceDir: path.join(root, 'clawspace'), syncDir: path.join(root, 'tasks/sync'),
      fs, llm: controlled.llm, registry,
    });
    const result = await runSpawnSync({
      intent: 'direct caller composition', timeoutMs: 5_000, maxSteps: 1,
      systemPrompt: 'controlled spawn system', ctx, subagentRunner: execution,
    });
    expect(result).toMatchObject({ success: true, content: 'direct spawn final body' });
    expect(result.metadata?.execution).toMatchObject({ runId: result.metadata.spawnId });
    const identity = result.metadata.execution as { resultDir: string };
    expect(JSON.parse(await fs.read(`${identity.resultDir}/execution/attempts/1/outcome.json`))).toMatchObject({
      kind: 'completed', content: 'direct spawn final body',
    });
    expect(controlled.calls()).toBe(1);
  });

  it('V11: verifier cancellation stays pending through a real gated tool, while a settled business rejection is a verdict', async () => {
    const { root, fs } = await fixture('verifier-direct');
    const gate = gatedTool('verifier_gate');
    const registry = new ToolRegistryImpl();
    registry.register(gate.tool);
    const controlled = fakeLlm([toolChunks('verifier_gate'), textChunks('{"passed":true,"reason":"must not win"}')]);
    const contractId = makeContractId('contract-phase2248-k');
    await fs.writeAtomic(`contract/active/${contractId}/progress.json`, JSON.stringify({
      schema_version: 1, subtasks: { t1: { status: 'todo' } },
    }));
    const signal = new AbortController();
    const attached: Array<{ completion: Promise<unknown> }> = [];
    const pending = runContractVerifier({
      agentId: 'verifier-phase2248-cancel', clawId: 'claw', clawDir: root, contractId,
      fs, llm: controlled.llm, audit: makeMockAudit(), prompt: 'verify', toolRegistry: registry,
      fsFactory: base => new NodeFileSystem({ baseDir: base }), signal: signal.signal,
    }, { attach: ref => { attached.push(ref); } });
    let verdictSettled = false;
    void pending.catch(() => { verdictSettled = true; });
    await gate.entered;
    expect(attached).toHaveLength(1);
    signal.abort({ type: 'test_cancel' });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(verdictSettled).toBe(false);

    gate.release({ success: true, content: 'verifier tool really settled' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(verdictSettled).toBe(true);
    expect(controlled.calls()).toBe(1);

    const rejectionLlm = fakeLlm([textChunks('{"passed":false,"reason":"actual business rejection"}')]);
    const rejectionId = makeContractId('contract-phase2248-k-rejection');
    await fs.writeAtomic(`contract/active/${rejectionId}/progress.json`, JSON.stringify({
      schema_version: 1, subtasks: { t1: { status: 'todo' } },
    }));
    await expect(runContractVerifier({
      agentId: 'verifier-phase2248-rejection', clawId: 'claw', clawDir: root, contractId: rejectionId,
      fs, llm: rejectionLlm.llm, audit: makeMockAudit(), prompt: 'verify', toolRegistry: new ToolRegistryImpl(),
      fsFactory: base => new NodeFileSystem({ baseDir: base }),
    })).resolves.toMatchObject({ passed: false, structured: { reason: 'actual business rejection' } });
  });
});
