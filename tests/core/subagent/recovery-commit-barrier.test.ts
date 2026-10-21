/**
 * Phase 1934 Step B: SubAgent 严格恢复提交屏障（F-12）测试。
 *
 * 语义修正：恢复启用时，dialog 保存与 cursor 提交均完成前不得发起下一 LLM
 * （1933 G 已保留 responseId，但 step_save/commitConversation 仍 best-effort，
 * 下一响应可能覆盖未提交游标）。故障后旧响应、工具结果和游标保持可重建。
 *
 * 矩阵：
 * A1 第一轮工具成功后注入 message save EIO → run 严格失败（原错传播）、第二次
 *    LLM 调用为零、旧 cursor 不变；重建 store/agent 后从旧响应恢复且工具不重复。
 * A2 注入 cursor commit EIO（save 已成功）→ run 严格失败、cursor 停留
 *    awaiting-conversation-commit；重启凭已提交事实 + 已落盘对话幂等恢复。
 * A3 初始 dialog 缺席（checkpoint 仅经 recovery 写路径）→ 全新构建基底上重建、
 *    保存、推进 next-llm。
 * A4 完整无工具响应（end_turn、toolResultIds=[]）→ finally 提交后 cursor 为
 *    next-llm；重启从持久对话继续、不重放响应。
 * A5 正常两 step：三次 LLM 调用、游标逐步推进、末尾 next-llm（版本连续）。
 * S1 store 屏障：awaiting-tools 游标在场 → llmResponseCommitted 拒绝覆盖
 *    （typed invalid_state），响应文件未写、旧 cursor 不变。
 * S2 store 屏障：cursor 损坏/读取未知 → typed throw（不按无记录继续）。
 * S3 store 屏障：next-llm 游标 → 允许提交新响应（唯一合法后继）。
 * S4 store 屏障：commitConversation 播种同样严格——cursor 损坏 → typed throw
 *    （不被 fallbackReason 吞成静默 no-op 让屏障假报成功）。
 * S5 store 屏障：commitConversation 在 cursor 确定缺席时仍 no-op（唯一合法缺席）。
 * R1 反向：展示 callback（steps.jsonl append）失败不改变严格结果。
 * R2 反向：未 started 工具可继续（pending 可证明未开始 → 执行并严格完成）。
 * R3 反向：started 无 result 仍拒绝重执行（uncertain，不请求 LLM、不动游标）。
 *
 * 构造惯例同 recovery-resume.test.ts：真实 temp dir + NodeFileSystem + 真
 * DialogStore + 真 RecoveryStore + 真 runReact loop；仅 llm / toolExecutor
 * 为 fake；故障注入用可控 wrapper/spy seam（不 sleep、不以 finally 正常保存
 * 模拟硬中断）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createDialogStore, type DialogStore, type Message } from '../../../src/foundation/dialog-store/index.js';
import type { ToolExecutor } from '../../../src/foundation/tools/index.js';
import type { LLMOrchestrator, LLMStreamChunk, LLMCallOptions } from '../../../src/foundation/llm-orchestrator/index.js';
import { makeToolUseId } from '../../../src/foundation/llm-provider/index.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import {
  createSubAgentRecoveryStore,
  RecoveryUncertainSideEffectError,
  SubAgentRecoveryStoreError,
} from '../../../src/core/subagent/recovery-state.js';
import type { CompleteLLMResponse } from '../../../src/core/step-executor/index.js';
import { createSubAgentLifecycleSink } from '../../../src/core/subagent/lifecycle-sink.js';
import { NoopStreamWriter } from '../../../src/core/subagent/noop-writers.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

// ── Fake LLM / Fake ToolExecutor（同 recovery-resume.test.ts 惯例） ──────────

type LlmScript = LLMStreamChunk[] | Error;

function toolUseStepChunks(tools: { id: string; name: string; input: Record<string, unknown> }[]): LLMStreamChunk[] {
  const chunks: LLMStreamChunk[] = [];
  for (const t of tools) {
    chunks.push({ type: 'tool_use_start', toolUse: { id: t.id, name: t.name, partialInput: '' } });
    chunks.push({ type: 'tool_use_delta', toolUse: { id: t.id, name: t.name, partialInput: JSON.stringify(t.input) } });
  }
  chunks.push({ type: 'done', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 } });
  return chunks;
}

function endTurnChunks(text: string): LLMStreamChunk[] {
  return [
    { type: 'text_delta', delta: text },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } },
  ];
}

function makeFakeLlm(scripts: LlmScript[]) {
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

type ExecuteImpl = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;

function makeFakeExecutor(impl: ExecuteImpl) {
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

// ── Harness：真 fs / DialogStore / RecoveryStore / runReact loop ─────────────

const AGENT_ID = 'barrier-agent';

function makeAgent(
  fs: NodeFileSystem,
  resultDir: string,
  opts: {
    llm: LLMOrchestrator;
    executor: ToolExecutor;
    auditRows: unknown[][];
    wrapMessageStore?: (ms: DialogStore) => DialogStore;
  },
) {
  const auditWriter = {
    write: vi.fn((event: string, ...cols: unknown[]) => {
      opts.auditRows.push([event, ...cols]);
    }),
  };
  const baseMessageStore = createDialogStore(fs, resultDir, auditWriter as never, 'messages.json');
  const messageStore = opts.wrapMessageStore ? opts.wrapMessageStore(baseMessageStore) : baseMessageStore;
  const store = createSubAgentRecoveryStore({ fs, resultDir });
  const sink = createSubAgentLifecycleSink({
    auditWriter: auditWriter as never,
    agentId: AGENT_ID,
    traceId: 'trace-barrier' as never,
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
    traceId: 'trace-barrier' as never,
    recoveryStore: store,
  });
  return { agent, store };
}

const TWO_TOOL_STEP = toolUseStepChunks([
  { id: 'toolu_a', name: 'tool_a', input: { x: 1 } },
  { id: 'toolu_b', name: 'tool_b', input: { y: 2 } },
]);

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

function endTurnResponseFact(): CompleteLLMResponse {
  return {
    response: {
      content: [{ type: 'text', text: 'plain done' }],
      stop_reason: 'end_turn',
    },
    llmInfo: { model: 'fake-model', inputTokens: 5, outputTokens: 5, latencyMs: 1 },
    committedAtMs: Date.now(),
  };
}

/** awaiting-tools checkpoint：两工具响应已提交；A 已 started+结果已提交，B 从未开始。 */
async function buildAwaitingToolsCheckpoint(fs: NodeFileSystem, resultDir: string) {
  const store = createSubAgentRecoveryStore({ fs, resultDir });
  await store.llmResponseCommitted(twoToolResponseFact());
  await store.toolStarted({ toolUseId: makeToolUseId('toolu_a'), toolName: 'tool_a', input: { x: 1 }, startedAtMs: Date.now() });
  await store.toolResultCommitted({
    toolUseId: makeToolUseId('toolu_a'),
    toolName: 'tool_a',
    result: { success: true, content: 'tool_a-ok' },
    resultAtMs: Date.now(),
  });
}

/** awaiting-conversation-commit checkpoint：响应 + 两工具结果全部提交，对话从未落盘。 */
async function buildConversationCommitCheckpoint(fs: NodeFileSystem, resultDir: string) {
  const store = createSubAgentRecoveryStore({ fs, resultDir });
  await store.llmResponseCommitted(twoToolResponseFact());
  for (const t of [
    { id: 'toolu_a', name: 'tool_a', input: { x: 1 } },
    { id: 'toolu_b', name: 'tool_b', input: { y: 2 } },
  ]) {
    await store.toolStarted({ toolUseId: makeToolUseId(t.id), toolName: t.name, input: t.input, startedAtMs: Date.now() });
    await store.toolResultCommitted({
      toolUseId: makeToolUseId(t.id),
      toolName: t.name,
      result: { success: true, content: `${t.name}-ok` },
      resultAtMs: Date.now(),
    });
  }
}

/** 默认续跑阶段：同 resultDir 新建 store/agent（fake llm 返回一次 end_turn）。 */
async function runResumePhase(
  fs: NodeFileSystem,
  resultDir: string,
  opts: { scripts?: LlmScript[]; executeImpl?: ExecuteImpl } = {},
) {
  const llm = makeFakeLlm(opts.scripts ?? [endTurnChunks('recovered final')]);
  const exec = makeFakeExecutor(
    opts.executeImpl ?? (async (toolName) => ({ success: true, content: `${toolName}-ok` })),
  );
  const auditRows: unknown[][] = [];
  const { agent } = makeAgent(fs, resultDir, {
    llm: llm.orchestrator,
    executor: exec.executor,
    auditRows,
  });
  const text = await agent.run();
  return { text, llm, exec, auditRows };
}

/** run() 预期 reject 时取回错误对象（保留原错 instanceof / message 判定）。 */
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

describe('Phase 1934 Step B: 严格恢复提交屏障（F-12）', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let resultDir: string;

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  async function setup(tag: string) {
    tempDir = await createTrackedTempDir(`chestnut-barrier-${tag}-`);
    fs = new NodeFileSystem({ baseDir: tempDir });
    resultDir = 'results/agent';
    return { tempDir, fs, resultDir };
  }

  it('A1 第一轮工具成功后 message save EIO → run 严格失败、第二次 LLM 为零、旧 cursor 不变；重启从旧响应恢复且工具不重复', async () => {
    const { tempDir: dir } = await setup('save-eio');
    // 阶段 1：两工具成功后 onStepComplete 严格 save 注入 EIO
    const llm1 = makeFakeLlm([TWO_TOOL_STEP, endTurnChunks('unreachable second')]);
    const exec1 = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows1: unknown[][] = [];
    const { agent: agent1 } = makeAgent(fs, resultDir, {
      llm: llm1.orchestrator,
      executor: exec1.executor,
      auditRows: auditRows1,
      wrapMessageStore: (ms) => {
        (ms as unknown as { save: unknown }).save = async () => {
          const err = new Error('injected save EIO') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        };
        return ms;
      },
    });

    const err = await captureRunError(agent1);
    // 严格失败：原错传播（不吞没、不降级为成功）
    expect((err as Error).message).toContain('injected save EIO');
    // 工具已执行并提交结果；第二次 LLM 调用为零（屏障在下一 LLM 之前）
    expect(exec1.calls.map((c) => c.toolName)).toEqual(['tool_a', 'tool_b']);
    expect(llm1.callCount()).toBe(1);
    // 留证：persist 失败事实入 audit
    expect(
      auditRows1.some((r) => r[0] === SUBAGENT_AUDIT_EVENTS.PERSIST_FAILED && String(r.join(' ')).includes('step_save')),
    ).toBe(true);
    // 旧 cursor 不变：停留 awaiting-conversation-commit（不提前发布 next-llm）
    const pre = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(pre.fallbackReason).toBeUndefined();
    expect(pre.cursor).toEqual({
      kind: 'awaiting-conversation-commit',
      responseId: expect.any(String),
      toolResultIds: ['toolu_a', 'toolu_b'],
    });
    const responseId = (pre.cursor as { responseId: string }).responseId;
    // 旧响应 + 工具结果事实保留可重建（不删 recovery 文件）
    expect(await fsp.stat(path.join(dir, resultDir, 'recovery', 'responses', `${responseId}.json`))).toBeTruthy();
    expect(await fsp.stat(path.join(dir, resultDir, 'recovery', 'tool-results', 'toolu_a.json'))).toBeTruthy();
    expect(await fsp.stat(path.join(dir, resultDir, 'recovery', 'tool-results', 'toolu_b.json'))).toBeTruthy();

    // 阶段 2：重建 store/agent（正常 messageStore）→ 从旧响应恢复
    const resume = await runResumePhase(fs, resultDir);

    expect(resume.text).toBe('recovered final');
    // 工具不重复执行（结果复原自已提交事实）；已提交响应不重放请求
    expect(resume.exec.calls).toHaveLength(0);
    expect(resume.llm.callCount()).toBe(1);
    const blocks = lastUserToolResultBlocks(resume.llm);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    expect(blocks.map((b) => b.content)).toEqual(['tool_a-ok', 'tool_b-ok']);
    // 恢复完成后 cursor 推进 next-llm（新响应已提交，responseId 为续跑回合锚点）
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.cursor).toEqual({
      kind: 'next-llm',
      responseId: expect.any(String),
      conversationVersion: expect.any(Number),
    });
  });

  it('A2 cursor commit EIO（save 已成功）→ run 严格失败、cursor 停留 awaiting-conversation-commit；重启凭已落盘对话幂等恢复', async () => {
    await setup('commit-eio');
    const llm1 = makeFakeLlm([TWO_TOOL_STEP, endTurnChunks('unreachable second')]);
    const exec1 = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows1: unknown[][] = [];
    const { agent: agent1, store: store1 } = makeAgent(fs, resultDir, {
      llm: llm1.orchestrator,
      executor: exec1.executor,
      auditRows: auditRows1,
    });
    // 可控 promise seam：commitConversation 恒 EIO（游标写失败）
    vi.spyOn(store1, 'commitConversation').mockRejectedValue(
      Object.assign(new Error('injected commit EIO'), { code: 'EIO' }),
    );

    const err = await captureRunError(agent1);
    expect((err as Error).message).toContain('injected commit EIO');
    expect(llm1.callCount()).toBe(1);
    // save 已成功（对话含完整回合），但游标停留 awaiting-conversation-commit
    const pre = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(pre.cursor?.kind).toBe('awaiting-conversation-commit');
    const dialogRaw = await fsp.readFile(path.join(tempDir, resultDir, 'messages.json'), 'utf-8');
    expect(dialogRaw).toContain('toolu_a');

    // 阶段 2：重建 → 幂等判重（回合已持久化）→ 仅补 commit 后继续
    const resume = await runResumePhase(fs, resultDir);

    expect(resume.text).toBe('recovered final');
    expect(resume.exec.calls).toHaveLength(0);
    expect(resume.llm.callCount()).toBe(1);
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.cursor?.kind).toBe('next-llm');
  });

  it('A3 初始 dialog 缺席：checkpoint 仅经 recovery 写路径 → 全新构建基底上重建并推进 next-llm', async () => {
    await setup('no-initial-dialog');
    await buildConversationCommitCheckpoint(fs, resultDir);
    // 边界前提：初始 dialog 从未落盘（messages.json 缺席 = 确定不存在，非损坏）
    expect(await fs.exists(`${resultDir}/messages.json`)).toBe(false);

    const resume = await runResumePhase(fs, resultDir);

    expect(resume.text).toBe('recovered final');
    expect(resume.exec.calls).toHaveLength(0);
    expect(resume.llm.callCount()).toBe(1);
    // 在全新构建序列（user prompt）上重建 assistant + tool_result
    const msgs = resume.llm.streamCalls[0].messages as Message[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const blocks = lastUserToolResultBlocks(resume.llm);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    // 重建后对话已落盘、cursor 推进 next-llm
    expect(await fs.exists(`${resultDir}/messages.json`)).toBe(true);
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.cursor?.kind).toBe('next-llm');
    expect(resume.auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK)).toHaveLength(0);
  });

  it('A4 完整无工具响应（end_turn）：finally 提交后 cursor 为 next-llm；重启从持久对话继续、不重放响应', async () => {
    await setup('no-tool-response');
    const llm1 = makeFakeLlm([endTurnChunks('plain done')]);
    const exec1 = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows1: unknown[][] = [];
    const { agent: agent1 } = makeAgent(fs, resultDir, {
      llm: llm1.orchestrator,
      executor: exec1.executor,
      auditRows: auditRows1,
    });
    const text1 = await agent1.run();

    expect(text1).toBe('plain done');
    expect(exec1.calls).toHaveLength(0);
    // end_turn 不触发步进回调 —— finally 保存 + 提交后 cursor 为 next-llm（含 responseId 锚点）
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.fallbackReason).toBeUndefined();
    expect(post.cursor).toEqual({
      kind: 'next-llm',
      responseId: expect.any(String),
      conversationVersion: expect.any(Number),
    });

    // 重启：next-llm 从持久对话恢复后继续（不重放已提交响应的请求事实）
    const resume = await runResumePhase(fs, resultDir, { scripts: [endTurnChunks('after restart')] });
    expect(resume.text).toBe('after restart');
    expect(resume.exec.calls).toHaveLength(0);
    const msgs = resume.llm.streamCalls[0].messages as Message[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(resume.auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK)).toHaveLength(0);
  });

  it('A5 正常两 step：三次 LLM 调用、游标逐步严格推进、末尾 next-llm（版本连续、无回退）', async () => {
    await setup('two-steps');
    const llm = makeFakeLlm([
      toolUseStepChunks([{ id: 'toolu_a', name: 'tool_a', input: { x: 1 } }]),
      toolUseStepChunks([{ id: 'toolu_c', name: 'tool_c', input: { z: 3 } }]),
      endTurnChunks('two steps done'),
    ]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, {
      llm: llm.orchestrator,
      executor: exec.executor,
      auditRows,
    });
    const text = await agent.run();

    expect(text).toBe('two steps done');
    expect(llm.callCount()).toBe(3);
    expect(exec.calls.map((c) => c.toolName)).toEqual(['tool_a', 'tool_c']);
    // 每步 save+commit 严格完成：末尾 next-llm，conversationVersion 逐响应递增（3 个响应）
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.fallbackReason).toBeUndefined();
    expect(post.cursor).toEqual({
      kind: 'next-llm',
      responseId: expect.any(String),
      conversationVersion: 3,
    });
    expect(auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK)).toHaveLength(0);
    expect(auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.PERSIST_FAILED)).toHaveLength(0);
  });

  it('S1 store 屏障：awaiting-tools 游标在场 → llmResponseCommitted 拒绝覆盖，响应文件未写、旧 cursor 不变', async () => {
    const { tempDir: dir } = await setup('store-overwrite-tools');
    const store = createSubAgentRecoveryStore({ fs, resultDir });
    await store.llmResponseCommitted(oneToolResponseFact());
    const before = await store.loadCursor();
    expect(before.cursor?.kind).toBe('awaiting-tools');

    const err = await store.llmResponseCommitted(twoToolResponseFact()).then(
      () => { throw new Error('expected llmResponseCommitted to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryStoreError);
    expect((err as SubAgentRecoveryStoreError).kind).toBe('invalid_state');
    expect((err as Error).message).toContain('previous response not committed');

    // 旧 cursor 不变、响应文件未新增（仍只有第一份）
    const after = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(after.cursor).toEqual(before.cursor);
    const responses = await fsp.readdir(path.join(dir, resultDir, 'recovery', 'responses'));
    expect(responses).toHaveLength(1);
  });

  it('S2 store 屏障：cursor 损坏/读取未知 → typed throw（不按无记录继续、不写新响应）', async () => {
    const { tempDir: dir } = await setup('store-corrupt-cursor');
    await fsp.mkdir(path.join(dir, resultDir, 'recovery'), { recursive: true });
    await fsp.writeFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), 'not-json{{{');

    const store = createSubAgentRecoveryStore({ fs, resultDir });
    const err = await store.llmResponseCommitted(oneToolResponseFact()).then(
      () => { throw new Error('expected llmResponseCommitted to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryStoreError);
    expect((err as SubAgentRecoveryStoreError).kind).toBe('corrupt');
    // 不写新响应、不清理坏记录（保留现场）
    expect(await fs.exists(`${resultDir}/recovery/responses`)).toBe(false);
    expect(await fsp.readFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), 'utf-8')).toBe('not-json{{{');
  });

  it('S3 store 屏障：next-llm 游标 → 允许提交新响应（唯一合法后继）', async () => {
    await setup('store-next-llm-ok');
    const store = createSubAgentRecoveryStore({ fs, resultDir });
    // 无工具响应 + 对话提交 → next-llm
    await store.llmResponseCommitted(endTurnResponseFact());
    await store.commitConversation();
    const seeded = await store.loadCursor();
    expect(seeded.cursor?.kind).toBe('next-llm');

    await store.llmResponseCommitted(oneToolResponseFact());

    const after = await store.loadCursor();
    expect(after.cursor).toEqual({
      kind: 'awaiting-tools',
      responseId: expect.any(String),
      pendingToolIds: ['toolu_a'],
      startedToolIds: [],
    });
  });

  it('S4 store 屏障：commitConversation 播种同样严格——cursor 损坏 → typed throw（不被 fallbackReason 吞成静默 no-op）', async () => {
    const { tempDir: dir } = await setup('store-commit-corrupt-cursor');
    await fsp.mkdir(path.join(dir, resultDir, 'recovery'), { recursive: true });
    await fsp.writeFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), 'not-json{{{');

    // 新进程语义：store 无内存播种，commitConversation 必须从磁盘严格加载
    const store = createSubAgentRecoveryStore({ fs, resultDir });
    const err = await store.commitConversation().then(
      () => { throw new Error('expected commitConversation to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryStoreError);
    expect((err as SubAgentRecoveryStoreError).kind).toBe('corrupt');
    // 坏记录原样保留（不清理现场）
    expect(await fsp.readFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), 'utf-8')).toBe('not-json{{{');
  });

  it('S5 store 屏障：commitConversation 在 cursor 确定缺席时仍 no-op（唯一合法缺席语义）', async () => {
    await setup('store-commit-no-cursor');
    const store = createSubAgentRecoveryStore({ fs, resultDir });
    await expect(store.commitConversation()).resolves.toBeUndefined();
    // 缺席不产生任何 cursor 文件
    expect(await fs.exists(`${resultDir}/recovery/cursor.json`)).toBe(false);
  });

  it('S6 store 严格三态（Phase 1958 Step B）：loadCursorStrict 区分 missing / valid / unreadable（保留原始原因）', async () => {
    const { tempDir: dir } = await setup('store-strict-tristate');
    // missing：确定不存在
    const store = createSubAgentRecoveryStore({ fs, resultDir });
    expect(await store.loadCursorStrict()).toEqual({ kind: 'missing' });
    // valid：schema 校验通过
    await store.llmResponseCommitted(oneToolResponseFact());
    const valid = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursorStrict();
    expect(valid.kind).toBe('valid');
    expect(valid).toMatchObject({ cursor: { kind: 'awaiting-tools', pendingToolIds: ['toolu_a'] } });
    // unreadable：损坏保留原始 reason + errorKind=corrupt（不猜成 missing）
    await fsp.writeFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), 'not-json{{{');
    const unreadable = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursorStrict();
    expect(unreadable.kind).toBe('unreadable');
    if (unreadable.kind === 'unreadable') {
      expect(unreadable.reason).toContain('cursor_parse_failed');
      expect(unreadable.errorKind).toBe('corrupt');
    }
    // unreadable：旧 schema 缺字段同样只能进 unreadable
    await fsp.writeFile(
      path.join(dir, resultDir, 'recovery', 'cursor.json'),
      JSON.stringify({ schema_version: 1, kind: 'awaiting-tools' }),
    );
    const legacy = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursorStrict();
    expect(legacy.kind).toBe('unreadable');
    if (legacy.kind === 'unreadable') {
      expect(legacy.reason).toContain('cursor_invalid');
      expect(legacy.errorKind).toBe('corrupt');
    }
  });

  it('R1 反向：展示 callback（steps.jsonl append）失败不改变严格结果（save+commit 仍完成、cursor 推进）', async () => {
    await setup('display-callback-fail');
    // 仅 steps.jsonl 追加失败（展示面）；dialog save / cursor 写不受影响
    const origAppend = fs.append.bind(fs);
    vi.spyOn(fs, 'append').mockImplementation(async (p: string, content: string) => {
      if (p.endsWith('steps.jsonl')) throw new Error('injected append failure');
      return origAppend(p, content);
    });
    const llm = makeFakeLlm([
      toolUseStepChunks([{ id: 'toolu_a', name: 'tool_a', input: { x: 1 } }]),
      endTurnChunks('display fail ok'),
    ]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, {
      llm: llm.orchestrator,
      executor: exec.executor,
      auditRows,
    });
    const text = await agent.run();

    expect(text).toBe('display fail ok');
    expect(llm.callCount()).toBe(2);
    // 展示面失败留证但不改变严格结果：cursor 推进 next-llm
    expect(auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.STEP_COMPLETE_FAILED).length).toBeGreaterThan(0);
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.cursor?.kind).toBe('next-llm');
  });

  it('R2 反向：未 started 工具可继续 —— pending 可证明未开始 → 执行并严格完成（next-llm）', async () => {
    await setup('not-started-continues');
    await buildAwaitingToolsCheckpoint(fs, resultDir);

    const resume = await runResumePhase(fs, resultDir);

    expect(resume.text).toBe('recovered final');
    // A 复原不重执行；B（可证明未开始）正常执行
    expect(resume.exec.calls.map((c) => c.toolName)).toEqual(['tool_b']);
    expect(resume.llm.callCount()).toBe(1);
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.cursor?.kind).toBe('next-llm');
    expect(resume.auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK)).toHaveLength(0);
  });

  it('R3 反向：started 无 result 仍拒绝重执行 —— uncertain 停止，不请求 LLM、不动游标', async () => {
    await setup('started-no-result');
    const store0 = createSubAgentRecoveryStore({ fs, resultDir });
    await store0.llmResponseCommitted(oneToolResponseFact());
    await store0.toolStarted({
      toolUseId: makeToolUseId('toolu_a'),
      toolName: 'tool_a',
      input: { x: 1 },
      startedAtMs: Date.now(),
    });

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, {
      llm: llm.orchestrator,
      executor: exec.executor,
      auditRows,
    });

    const err = await captureRunError(agent);
    expect(err).toBeInstanceOf(RecoveryUncertainSideEffectError);
    expect((err as RecoveryUncertainSideEffectError).toolUseId).toBe('toolu_a');
    expect(exec.calls).toHaveLength(0);
    expect(llm.callCount()).toBe(0);
    // 游标原样保留（现场不清理）
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.cursor).toMatchObject({
      kind: 'awaiting-tools',
      pendingToolIds: ['toolu_a'],
      startedToolIds: ['toolu_a'],
    });
  });
});
