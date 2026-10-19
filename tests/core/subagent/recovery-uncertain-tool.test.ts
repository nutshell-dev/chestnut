/**
 * Phase 1933 Step G: 恢复游标安全边界 —— 不确定副作用（uncertain）矩阵。
 *
 * 已 toolStarted 但无 toolResultCommitted 的工具：外部副作用是否发生不可知 →
 * resume 不自动重执行，抛 RecoveryUncertainSideEffectError 停在该状态
 * （不删 recovery 文件、不静默全新重启、不当成功/失败/未开始）。
 *
 * 矩阵：
 * ① started 无 result 不重执行：pending=[A]、startedToolIds=[A]、无 A 结果 →
 *    resume 抛 RecoveryUncertainSideEffectError、executor 对 A 零调用、不请求 LLM。
 * ② 可证明未开始则执行：pending=[A]、startedToolIds=[] → A 正常执行并推进。
 * ③ 旧 cursor 缺 startedToolIds 字段：pending=[A] → 不可证明未开始 → uncertain（不猜测）。
 * ④ 混合：pending=[A,B]，A 已提交 result、B 未 started → A 复原不重执行、B 执行。
 * ⑤ 外部工具成功但结果丢失：started=[A]、A 的 result 文件损坏 →
 *    停在 uncertain + audit 留证，不删文件、不全新重启。
 *
 * 构造惯例同 recovery-resume.test.ts：真实 temp dir + NodeFileSystem + 真 DialogStore
 * + 真 RecoveryStore + 真 runReact loop；仅 llm 与 toolExecutor 为 fake。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createDialogStore, type Message } from '../../../src/foundation/dialog-store/index.js';
import type { ToolExecutor } from '../../../src/foundation/tools/index.js';
import type { LLMOrchestrator, LLMStreamChunk, LLMCallOptions } from '../../../src/foundation/llm-orchestrator/index.js';
import { makeToolUseId } from '../../../src/foundation/llm-provider/index.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import {
  createSubAgentRecoveryStore,
  RecoveryUncertainSideEffectError,
} from '../../../src/core/subagent/recovery-state.js';
import type { CompleteLLMResponse } from '../../../src/core/step-executor/index.js';
import { createSubAgentLifecycleSink } from '../../../src/core/subagent/lifecycle-sink.js';
import { NoopStreamWriter } from '../../../src/core/subagent/noop-writers.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

// ── Fake LLM / Fake ToolExecutor（同 recovery-resume.test.ts 惯例） ──────────

function endTurnChunks(text: string): LLMStreamChunk[] {
  return [
    { type: 'text_delta', delta: text },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } },
  ];
}

function makeFakeLlm(scripts: (LLMStreamChunk[] | Error)[]) {
  const streamCalls: LLMCallOptions[] = [];
  let callCount = 0;
  const stream = vi.fn((_opts: LLMCallOptions): AsyncIterableIterator<LLMStreamChunk> => {
    callCount++;
    streamCalls.push({ ..._opts, messages: structuredClone(_opts.messages) });
    const script = scripts[callCount - 1];
    if (!script) throw new Error(`fake llm: no script for call #${callCount}`);
    return (async function* () {
      if (script instanceof Error) throw script;
      for (const c of script) yield c;
    })();
  });
  const orchestrator = {
    stream,
    call: vi.fn(),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'fake', model: 'fake-model', isFallback: false })),
    resetLastSuccessProvider: vi.fn(),
    getFailureDisposition: vi.fn(() => 'unknown' as const),
    close: vi.fn(async () => {}),
    reloadConfig: vi.fn(),
  } as unknown as LLMOrchestrator;
  return { orchestrator, streamCalls, callCount: () => callCount };
}

function makeFakeExecutor(impl: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>) {
  const calls: { toolName: string; args: Record<string, unknown> }[] = [];
  const execute = vi.fn(async (options: { toolName: string; args: Record<string, unknown> }): Promise<ToolResult> => {
    calls.push({ toolName: options.toolName, args: options.args });
    return impl(options.toolName, options.args);
  });
  const executor = {
    execute,
    getExecContext: vi.fn(
      (_profile: string, opts: { clawId: string; signal?: AbortSignal; trace_id?: unknown }) =>
        makeExecContext({ clawId: opts.clawId, signal: opts.signal, trace_id: opts.trace_id as never }),
    ),
  } as unknown as ToolExecutor;
  return { executor, calls };
}

// ── Harness ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'uncertain-agent';

function makeAgent(
  fs: NodeFileSystem,
  resultDir: string,
  opts: { llm: LLMOrchestrator; executor: ToolExecutor; auditRows: unknown[][] },
) {
  const auditWriter = {
    write: vi.fn((event: string, ...cols: unknown[]) => {
      opts.auditRows.push([event, ...cols]);
    }),
  };
  const messageStore = createDialogStore(fs, resultDir, auditWriter as never, 'messages.json');
  const store = createSubAgentRecoveryStore({ fs, resultDir });
  const sink = createSubAgentLifecycleSink({
    auditWriter: auditWriter as never,
    agentId: AGENT_ID,
    traceId: 'trace-uncertain' as never,
  });
  const registry = {
    get: vi.fn(() => undefined),
    getAll: vi.fn(() => []),
    formatForLLM: vi.fn(() => []),
  };
  const agent = new SubAgent({
    agentId: AGENT_ID,
    resultDir,
    messageStore,
    prompt: 'do the task',
    systemPrompt: 'sys',
    toolExecutor: opts.executor,
    llm: opts.llm,
    registry: registry as never,
    fs,
    maxSteps: 10,
    timeoutMs: 60_000,
    taskStreamWriter: new NoopStreamWriter(),
    sink,
    traceId: 'trace-uncertain' as never,
    recoveryStore: store,
  });
  return { agent, store };
}

function oneToolResponseFact(): CompleteLLMResponse {
  return {
    response: {
      content: [
        { type: 'tool_use', id: makeToolUseId('toolu_a'), name: 'tool_a', input: { x: 1 } },
      ],
      stop_reason: 'tool_use',
    },
    llmInfo: { model: 'fake-model', inputTokens: 5, outputTokens: 5, latencyMs: 1 },
    committedAtMs: Date.now(),
  };
}

function twoToolResponseFact(): CompleteLLMResponse {
  return {
    response: {
      content: [
        { type: 'tool_use', id: makeToolUseId('toolu_a'), name: 'tool_a', input: { x: 1 } },
        { type: 'tool_use', id: makeToolUseId('toolu_b'), name: 'tool_b', input: { y: 2 } },
      ],
      stop_reason: 'tool_use',
    },
    llmInfo: { model: 'fake-model', inputTokens: 5, outputTokens: 5, latencyMs: 1 },
    committedAtMs: Date.now(),
  };
}

/** 构造 checkpoint：单工具响应已提交 + A 已 started、无 A 结果（「执行中崩溃」窗口）。 */
async function buildOneToolStartedNoResult(fs: NodeFileSystem, resultDir: string) {
  const store = createSubAgentRecoveryStore({ fs, resultDir });
  await store.llmResponseCommitted(oneToolResponseFact());
  await store.toolStarted({
    toolUseId: makeToolUseId('toolu_a'),
    toolName: 'tool_a',
    input: { x: 1 },
    startedAtMs: Date.now(),
  });
}

/** run() 预期 reject 时取回错误对象（保留 instanceof 判定）。 */
async function captureRunError(agent: SubAgent): Promise<unknown> {
  return agent.run().then(
    () => { throw new Error('expected run to reject'); },
    (e: unknown) => e,
  );
}

function lastUserToolResultBlocks(llm: ReturnType<typeof makeFakeLlm>) {
  const msgs = llm.streamCalls[0].messages as Message[];
  const last = msgs[msgs.length - 1];
  expect(last.role).toBe('user');
  expect(Array.isArray(last.content)).toBe(true);
  return (last.content as Array<{ type: string; tool_use_id: string; content: string }>)
    .filter((b) => b.type === 'tool_result');
}

describe('Phase 1933 Step G: 恢复游标安全边界 —— 不确定副作用', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let resultDir: string;

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  async function setup(tag: string) {
    tempDir = await createTrackedTempDir(`chestnut-unc-${tag}-`);
    fs = new NodeFileSystem({ baseDir: tempDir });
    resultDir = 'results/agent';
    return { tempDir, fs, resultDir };
  }

  it('① started 无 result 不重执行：resume 抛 RecoveryUncertainSideEffectError、executor 零调用、不请求 LLM', async () => {
    await setup('started-no-result');
    await buildOneToolStartedNoResult(fs, resultDir);

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });

    const err = await captureRunError(agent);
    expect(err).toBeInstanceOf(RecoveryUncertainSideEffectError);
    expect((err as RecoveryUncertainSideEffectError).toolUseId).toBe('toolu_a');
    // A 零调用（不重复副作用）、不请求 LLM
    expect(exec.calls).toHaveLength(0);
    expect(llm.callCount()).toBe(0);
    // audit 留证 uncertain 原因
    const fallbackRows = auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK);
    expect(fallbackRows.some((r) => String(r.join(' ')).includes('uncertain_side_effect'))).toBe(true);
    // 不停在损坏/删除：cursor 保持 awaiting-tools（可再次进入同一 uncertain 判定）
    const loaded = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(loaded.cursor?.kind).toBe('awaiting-tools');
  });

  it('② 可证明未开始则执行：pending=[A]、startedToolIds=[] → A 正常执行并推进', async () => {
    await setup('provably-not-started');
    // 仅提交响应（started=[] 证据在场）→ A 可证明未开始
    const store0 = createSubAgentRecoveryStore({ fs, resultDir });
    await store0.llmResponseCommitted(oneToolResponseFact());

    const llm = makeFakeLlm([endTurnChunks('executed final')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });
    const text = await agent.run();

    expect(text).toBe('executed final');
    expect(exec.calls.map((c) => c.toolName)).toEqual(['tool_a']);
    expect(llm.callCount()).toBe(1);
  });

  it('③ 旧 cursor 缺 startedToolIds 字段：不可证明未开始 → uncertain（不猜测、不执行）', async () => {
    const { tempDir: dir } = await setup('legacy-cursor');
    const store0 = createSubAgentRecoveryStore({ fs, resultDir });
    await store0.llmResponseCommitted(oneToolResponseFact());
    const seeded = await store0.loadCursor();
    const responseId = (seeded.cursor as { responseId: string }).responseId;
    // 手写旧版 cursor：缺 startedToolIds 字段（严格读取通过、语义 = 不可证明未开始）
    await fsp.writeFile(
      path.join(dir, resultDir, 'recovery', 'cursor.json'),
      JSON.stringify({ schema_version: 1, kind: 'awaiting-tools', responseId, pendingToolIds: ['toolu_a'] }),
    );

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });

    const err = await captureRunError(agent);
    expect(err).toBeInstanceOf(RecoveryUncertainSideEffectError);
    expect((err as RecoveryUncertainSideEffectError).toolUseId).toBe('toolu_a');
    expect(exec.calls).toHaveLength(0);
    expect(llm.callCount()).toBe(0);
  });

  it('④ 混合：pending=[A,B]，A 已提交 result、B 未 started → A 复原不重执行、B 执行', async () => {
    const { tempDir: dir } = await setup('mixed');
    const store0 = createSubAgentRecoveryStore({ fs, resultDir });
    await store0.llmResponseCommitted(twoToolResponseFact());
    await store0.toolStarted({ toolUseId: makeToolUseId('toolu_a'), toolName: 'tool_a', input: { x: 1 }, startedAtMs: Date.now() });
    await store0.toolResultCommitted({
      toolUseId: makeToolUseId('toolu_a'),
      toolName: 'tool_a',
      result: { success: true, content: 'tool_a-ok' },
      resultAtMs: Date.now(),
    });
    const seeded = await store0.loadCursor();
    const responseId = (seeded.cursor as { responseId: string }).responseId;
    // 构造 pending=[A,B] 且 A 结果在场的中间态（A ∈ pending 但已提交 → 复原语义优先）
    await fsp.writeFile(
      path.join(dir, resultDir, 'recovery', 'cursor.json'),
      JSON.stringify({
        schema_version: 1,
        kind: 'awaiting-tools',
        responseId,
        pendingToolIds: ['toolu_a', 'toolu_b'],
        startedToolIds: ['toolu_a'],
        committedToolIds: ['toolu_a'],
      }),
    );

    const llm = makeFakeLlm([endTurnChunks('mixed final')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });
    const text = await agent.run();

    expect(text).toBe('mixed final');
    // A 未重执行（结果复原自已提交事实）；仅 B 被执行
    expect(exec.calls.map((c) => c.toolName)).toEqual(['tool_b']);
    const blocks = lastUserToolResultBlocks(llm);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    expect(blocks.map((b) => b.content)).toEqual(['tool_a-ok', 'tool_b-ok']);
  });

  it('⑤ 外部工具成功但结果丢失：started=[A]、A 的 result 文件损坏 → 停 uncertain + audit 留证，不删文件、不全新重启', async () => {
    const { tempDir: dir } = await setup('corrupt-result');
    await buildOneToolStartedNoResult(fs, resultDir);
    // A 的结果文件存在但损坏（副作用或已发生、事实不可读 → 不可证明未开始）
    const toolResultsDir = path.join(dir, resultDir, 'recovery', 'tool-results');
    await fsp.mkdir(toolResultsDir, { recursive: true });
    const corruptPath = path.join(toolResultsDir, 'toolu_a.json');
    await fsp.writeFile(corruptPath, 'corrupt{{{');

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });

    const err = await captureRunError(agent);
    expect(err).toBeInstanceOf(RecoveryUncertainSideEffectError);
    expect((err as RecoveryUncertainSideEffectError).toolUseId).toBe('toolu_a');
    // 不执行、不请求 LLM、不静默全新重启
    expect(exec.calls).toHaveLength(0);
    expect(llm.callCount()).toBe(0);
    // audit 留证 uncertain 原因
    const fallbackRows = auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK);
    expect(fallbackRows.some((r) => String(r.join(' ')).includes('uncertain_side_effect'))).toBe(true);
    // 不删文件绕过：损坏事实文件与 cursor 原样保留
    expect(await fsp.readFile(corruptPath, 'utf-8')).toBe('corrupt{{{');
    const loaded = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(loaded.cursor).toMatchObject({
      kind: 'awaiting-tools',
      pendingToolIds: ['toolu_a'],
      startedToolIds: ['toolu_a'],
    });
  });
});
