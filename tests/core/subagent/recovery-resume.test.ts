/**
 * Phase 1933 Step D: SubAgent 通用安全续跑测试。
 *
 * 矩阵：
 * ① 重启续跑（不重复请求 LLM）：第 1 步响应已提交、工具 1 结果已提交、工具 2 执行时崩溃；
 *    同 resultDir 续跑 → llm stream 仅被调 1 次（第 2 步 end_turn），不重放第 1 步请求。
 * ② 已提交工具不重复执行：工具 1 结果来自 tool-results 存储；结果消息按原始顺序完整。
 * ③ 完整响应继续工具：续跑入口直接执行 pending 工具（先于第二次 LLM 调用）。
 * ④ cursor 损坏/不可读阻断（Phase 1958 Step B）：坏 JSON / 缺字段（旧 schema）/ 读取
 *    IO 失败 → resume 入口 typed recovery-required 阻断（SubAgentRecoveryRequiredError），
 *    留证保留、不发起新 LLM、不执行工具、现场保留（不按无 cursor 继续）。
 * ⑤ 取消不误判：resume 段执行 pending 工具时 abort → 按 abort 分类传播，不落 LLM 失败。
 * ⑥ 无 checkpoint 回归（runSubagent 全链路）：全新 resultDir 行为与现状一致。
 * ⑦ next-llm 续跑：首轮工具全部提交后崩溃于下一步 LLM 前 → 从持久 messages 继续、
 *    不重放已完成工具。
 * ⑧（Step G）重启窗口 awaiting-conversation-commit：响应 + 全部工具结果已提交、
 *    对话未保存 → 不请求 LLM、不执行任何工具，重建对话并保存后 cursor 推进 next-llm。
 * ⑨（Step G→Step B）对话保存失败 → 严格失败传播（不发起下一 LLM）、不提前发布
 *    next-llm（cursor 保持 awaiting-conversation-commit）；修复后重启可恢复。
 * ⑩（Step G）正常完成路径末尾 cursor 为 next-llm 且含 responseId。
 *
 * Step G 语义适配：旧「工具 B 执行时崩溃」场景 = B 已 started 无 result → 重启属
 * uncertain 矩阵（见 recovery-uncertain-tool.test.ts）；本文件 awaiting-tools 场景
 * 改为构造「A 结果提交后、B 开始前」的崩溃窗口（B 可证明未开始）。
 *
 * 构造惯例：真实 temp dir + NodeFileSystem + 真 DialogStore + 真 RecoveryStore +
 * 真 runReact loop；仅 llm（async generator stream）与 toolExecutor 为 fake
 * （崩溃注入需要 executor 面 seam——真 ToolExecutor 会把工具错误收敛为失败 ToolResult，
 * 无法制造 run 级崩溃）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createDialogStore, type DialogStore, type Message } from '../../../src/foundation/dialog-store/index.js';
import { createToolRegistry, type ToolExecutor } from '../../../src/foundation/tools/index.js';
import type { LLMOrchestrator, LLMStreamChunk, LLMCallOptions } from '../../../src/foundation/llm-orchestrator/index.js';
import { ExternalAbortError, isAbortError, makeExternalAbortError, makeToolUseId } from '../../../src/foundation/llm-provider/index.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import { runSubagent } from '../../../src/core/subagent/run.js';
import {
  createSubAgentRecoveryStore,
  SubAgentRecoveryRequiredError,
  type SubAgentRecoveryStore,
} from '../../../src/core/subagent/recovery-state.js';
import type { CompleteLLMResponse } from '../../../src/core/step-executor/index.js';
import { createSubAgentLifecycleSink } from '../../../src/core/subagent/lifecycle-sink.js';
import { NoopStreamWriter } from '../../../src/core/subagent/noop-writers.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

// ── Fake LLM（脚本化 stream；Error 脚本 = 该次调用失败） ─────────────────────

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

function makeFakeLlm(scripts: LlmScript[], log?: string[]) {
  const streamCalls: LLMCallOptions[] = [];
  let callCount = 0;
  const stream = vi.fn((_opts: LLMCallOptions): AsyncIterableIterator<LLMStreamChunk> => {
    callCount++;
    // messages 是 caller 持有的活数组（后续 step 会原地 append）——快照深拷贝取证
    streamCalls.push({ ..._opts, messages: structuredClone(_opts.messages) });
    log?.push(`llm.stream#${callCount}`);
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

// ── Fake ToolExecutor（execute 记录 + 脚本化行为；getExecContext 透传 signal） ──

type ExecuteImpl = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;

function makeFakeExecutor(impl: ExecuteImpl, log?: string[]) {
  const calls: { toolName: string; args: Record<string, unknown> }[] = [];
  const execute = vi.fn(async (options: { toolName: string; args: Record<string, unknown> }): Promise<ToolResult> => {
    calls.push({ toolName: options.toolName, args: options.args });
    log?.push(`execute:${options.toolName}`);
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

const AGENT_ID = 'rec-agent';

function makeAgent(
  fs: NodeFileSystem,
  resultDir: string,
  opts: {
    llm: LLMOrchestrator;
    executor: ToolExecutor;
    auditRows: unknown[][];
    signal?: AbortSignal;
    /** Step G: 包装 messageStore（如注入 save 失败） */
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
    traceId: 'trace-rec' as never,
  });
  const registry = {
    get: vi.fn(() => undefined), // 无 readonly 声明 → 串行 write 执行路径
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
    signal: opts.signal,
    taskStreamWriter: new NoopStreamWriter(),
    sink,
    traceId: 'trace-rec' as never,
    recoveryStore: store,
  });
  return { agent, store };
}

const TWO_TOOL_STEP = toolUseStepChunks([
  { id: 'toolu_a', name: 'tool_a', input: { x: 1 } },
  { id: 'toolu_b', name: 'tool_b', input: { y: 2 } },
]);

/** 两个 tool_use 的完整响应事实（checkpoint 构造用，与 TWO_TOOL_STEP 同工具集）。 */
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

/**
 * 构造 awaiting-tools checkpoint（真实 store 写路径）：两工具完整响应已提交；
 * 工具 A 已 started + 结果已提交，工具 B 从未开始（pending）——等价于
 * 「A 结果提交后、B 开始前」的崩溃窗口。
 */
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

/** 构造 awaiting-conversation-commit checkpoint：响应 + 两工具结果全部提交，对话从未落盘。 */
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

/** 阶段 2：同 resultDir 新建 store/agent 续跑（fake llm 第二步返回 end_turn）。 */
async function runResumePhase(
  fs: NodeFileSystem,
  resultDir: string,
  opts: { log?: string[]; signal?: AbortSignal; executeImpl?: ExecuteImpl } = {},
) {
  const llm = makeFakeLlm([endTurnChunks('recovered final')], opts.log);
  const exec = makeFakeExecutor(
    opts.executeImpl ?? (async (toolName) => ({ success: true, content: `${toolName}-ok` })),
    opts.log,
  );
  const auditRows: unknown[][] = [];
  const { agent } = makeAgent(fs, resultDir, {
    llm: llm.orchestrator,
    executor: exec.executor,
    auditRows,
    signal: opts.signal,
  });
  const text = await agent.run();
  return { text, llm, exec, auditRows };
}

function lastUserToolResultBlocks(llm: ReturnType<typeof makeFakeLlm>) {
  const msgs = llm.streamCalls[0].messages as Message[];
  const last = msgs[msgs.length - 1];
  expect(last.role).toBe('user');
  expect(Array.isArray(last.content)).toBe(true);
  return (last.content as Array<{ type: string; tool_use_id: string; content: string }>)
    .filter((b) => b.type === 'tool_result');
}

describe('Phase 1933 Step D: SubAgent 通用安全续跑', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let resultDir: string;

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  async function setup(tag: string) {
    tempDir = await createTrackedTempDir(`chestnut-rec-${tag}-`);
    fs = new NodeFileSystem({ baseDir: tempDir });
    resultDir = 'results/agent';
    return { tempDir, fs, resultDir };
  }

  it('① 重启续跑：已提交完整响应不重复请求 LLM，pending 工具执行后推进对话', async () => {
    await setup('rejoin');
    await buildAwaitingToolsCheckpoint(fs, resultDir);

    const resume = await runResumePhase(fs, resultDir);

    // llm stream 仅被调 1 次（第二步 end_turn；第 1 步响应来自 checkpoint、未新请求）
    expect(resume.llm.callCount()).toBe(1);
    expect(resume.text).toBe('recovered final');
    // 续跑后 LLM 看到的对话末尾：配对完整的 tool_result user 消息
    const blocks = lastUserToolResultBlocks(resume.llm);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
  });

  it('② 已提交工具不重复执行：工具 1 结果来自 tool-results 存储，顺序完整', async () => {
    await setup('no-reexec');
    await buildAwaitingToolsCheckpoint(fs, resultDir);

    const resume = await runResumePhase(fs, resultDir);

    // 工具 1 未再次执行（结果复原自已提交事实）；仅 pending 的工具 2 被执行
    expect(resume.exec.calls.map((c) => c.toolName)).toEqual(['tool_b']);
    const blocks = lastUserToolResultBlocks(resume.llm);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    expect(blocks.map((b) => b.content)).toEqual(['tool_a-ok', 'tool_b-ok']);
  });

  it('③ 完整响应继续工具：pending 工具执行发生在第二次 LLM 调用之前', async () => {
    await setup('order');
    const log: string[] = [];
    await buildAwaitingToolsCheckpoint(fs, resultDir);

    await runResumePhase(fs, resultDir, { log });

    expect(log).toEqual(['execute:tool_b', 'llm.stream#1']);
  });

  it('④a cursor 坏 JSON → Phase 1958 Step B: resume 入口 typed recovery-required 阻断，不发起新 LLM、现场保留', async () => {
    const { tempDir: dir } = await setup('corrupt-json');
    await fsp.mkdir(path.join(dir, resultDir, 'recovery'), { recursive: true });
    await fsp.writeFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), 'not-json{{{');

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });

    // 损坏游标不再按无 cursor 继续：resume 入口即 typed 阻断（恢复事实不可判定 → 不猜）
    const err = await agent.run().then(
      () => { throw new Error('expected run to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryRequiredError);
    expect((err as SubAgentRecoveryRequiredError).reason).toContain('cursor_parse_failed');
    // 阻断发生在 resume 入口：不发起新 LLM、不执行任何工具
    expect(llm.callCount()).toBe(0);
    expect(exec.calls).toHaveLength(0);
    // 阻断留证（原因入 audit）
    const fallbackRows = auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK);
    expect(fallbackRows).toHaveLength(1);
    expect(String(fallbackRows[0].join(' '))).toContain('cursor_parse_failed');
    // 坏记录现场保留（不自动重放、不清理 recovery 目录、不以 fresh 对话覆盖）
    expect(await fsp.readFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), 'utf-8')).toBe('not-json{{{');
    expect(await fs.exists(`${resultDir}/messages.json`)).toBe(false);
  });

  it('④b cursor 缺字段（旧 schema 校验失败）→ unreadable 而非 missing：typed 阻断、现场保留', async () => {
    const { tempDir: dir } = await setup('corrupt-schema');
    const badCursor = JSON.stringify({ schema_version: 1, kind: 'awaiting-tools' }); // 缺 responseId/pendingToolIds
    await fsp.mkdir(path.join(dir, resultDir, 'recovery'), { recursive: true });
    await fsp.writeFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), badCursor);

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });

    // 旧 schema 缺字段只能进 unreadable（不得猜成 missing）：resume 入口 typed 阻断
    const err = await agent.run().then(
      () => { throw new Error('expected run to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryRequiredError);
    expect((err as SubAgentRecoveryRequiredError).reason).toContain('cursor_invalid');
    expect(llm.callCount()).toBe(0);
    const fallbackRows = auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK);
    expect(fallbackRows).toHaveLength(1);
    expect(String(fallbackRows[0].join(' '))).toContain('cursor_invalid');
    // 坏记录现场保留
    expect(await fsp.readFile(path.join(dir, resultDir, 'recovery', 'cursor.json'), 'utf-8')).toBe(badCursor);
  });

  it('④c cursor 读取 IO 失败 → resume 入口 typed 阻断（保留 io 原因），不发起新 LLM', async () => {
    await setup('corrupt-io');
    // 有效 checkpoint 在场，但读路径注入 EACCES（只拦截 cursor.json 的 read）
    await buildAwaitingToolsCheckpoint(fs, resultDir);
    class CursorIoFailFs extends NodeFileSystem {
      override async read(p: string): Promise<string> {
        if (p.endsWith(path.join('recovery', 'cursor.json'))) {
          throw new Error('EACCES: injected cursor read failure');
        }
        return super.read(p);
      }
    }
    const ioFs = new CursorIoFailFs({ baseDir: tempDir });

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(ioFs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });

    const err = await agent.run().then(
      () => { throw new Error('expected run to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryRequiredError);
    expect((err as SubAgentRecoveryRequiredError).reason).toContain('cursor_read_failed');
    expect(llm.callCount()).toBe(0);
    expect(exec.calls).toHaveLength(0);
    const fallbackRows = auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK);
    expect(fallbackRows).toHaveLength(1);
    expect(String(fallbackRows[0].join(' '))).toContain('cursor_read_failed');
    // cursor 现场保留（有效内容未被覆盖）
    const loaded = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(loaded.fallbackReason).toBeUndefined();
    expect(loaded.cursor?.kind).toBe('awaiting-tools');
  });

  it('⑤ 取消不误判：resume 段执行 pending 工具时 abort → abort 分类传播、不落 LLM 失败事实', async () => {
    await setup('abort');
    // pending=[B] 且可证明未开始（started=[A]）——resume 会实际执行 B
    await buildAwaitingToolsCheckpoint(fs, resultDir);

    const controller = new AbortController();
    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => {
      // pending 工具执行时外部 abort 触发；abort-aware 工具以 abort 错误抛出
      controller.abort({ type: 'user' });
      throw makeExternalAbortError(controller.signal.reason);
    });
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, {
      llm: llm.orchestrator,
      executor: exec.executor,
      auditRows,
      signal: controller.signal,
    });

    const err = await agent.run().then(
      () => { throw new Error('expected run to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExternalAbortError);
    expect(isAbortError(err)).toBe(true);
    // 分类为外部中断，而非 LLM/业务失败
    expect(auditRows.filter((r) => r[0] === 'llm_error')).toHaveLength(0);
    expect(auditRows.filter((r) => r[0] === 'turn_error')).toHaveLength(0);
    const interrupted = auditRows.filter((r) => r[0] === 'turn_interrupted');
    expect(interrupted).toHaveLength(1);
    expect(String(interrupted[0].join(' '))).toContain('cause=external');
    // 第二次 LLM 调用未发生
    expect(llm.callCount()).toBe(0);
    // cursor 保持 awaiting-tools 且 toolu_b 仍 pending（失败事实不被误标为已提交）；
    // resume 执行 B 前已提交其 started 事实（Step G: startedToolIds 随游标保留并读出）
    const store: SubAgentRecoveryStore = createSubAgentRecoveryStore({ fs, resultDir });
    const loaded = await store.loadCursor();
    expect(loaded.fallbackReason).toBeUndefined();
    expect(loaded.cursor).toEqual({
      kind: 'awaiting-tools',
      responseId: expect.any(String),
      pendingToolIds: ['toolu_b'],
      startedToolIds: ['toolu_a', 'toolu_b'],
    });
  });

  it('⑥ 无 checkpoint 回归（runSubagent 全链路）：全新 resultDir 行为与现状一致', async () => {
    const { tempDir: dir } = await setup('fresh');
    const llm = makeFakeLlm([endTurnChunks('hello done')]);
    const registry = createToolRegistry();

    const result = await runSubagent({
      agentId: 'fresh-agent',
      clawDir: 'claw',
      fs,
      llm: llm.orchestrator,
      registry,
      prompt: 'do the task',
      systemPrompt: 'sys',
      resultDir,
      syncDir: 'sync',
    });

    expect(result.text).toBe('hello done');
    // 首次 LLM 正常调用、消息从 prompt 全新构建
    expect(llm.callCount()).toBe(1);
    const msgs = llm.streamCalls[0].messages as Message[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'do the task' });
    // 无回退留证
    const auditContent = await fsp.readFile(path.join(dir, resultDir, 'audit.tsv'), 'utf-8');
    expect(auditContent).not.toContain(SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK);
  });

  it('⑦ next-llm 续跑：首轮工具全部提交后崩溃于下一步 LLM 前 → 从持久 messages 继续、不重放工具', async () => {
    await setup('next-llm');
    // 阶段 1：第 1 步完整完成（两工具提交 + step 落盘），第 2 步 LLM 调用失败
    const llm1 = makeFakeLlm([TWO_TOOL_STEP, new Error('llm down')]);
    const exec1 = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows1: unknown[][] = [];
    const { agent: agent1 } = makeAgent(fs, resultDir, { llm: llm1.orchestrator, executor: exec1.executor, auditRows: auditRows1 });
    await expect(agent1.run()).rejects.toThrow('llm down');
    expect(exec1.calls.map((c) => c.toolName)).toEqual(['tool_a', 'tool_b']);
    expect(llm1.callCount()).toBe(2);

    // 阶段 2：cursor=next-llm → 恢复持久 messages 后直接进 runReact
    const resume = await runResumePhase(fs, resultDir);

    expect(resume.text).toBe('recovered final');
    // 不重放已完成工具
    expect(resume.exec.calls).toHaveLength(0);
    // 仅从持久 messages 继续发起一次新 LLM 调用；对话含完整首轮（user/assistant/tool_results）
    expect(resume.llm.callCount()).toBe(1);
    const msgs = resume.llm.streamCalls[0].messages as Message[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const blocks = lastUserToolResultBlocks(resume.llm);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    // 无回退发生
    expect(resume.auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK)).toHaveLength(0);
  });

  it('⑧ 重启窗口（awaiting-conversation-commit）：响应+全部工具结果已提交、对话未保存 → 不请求 LLM/不执行工具，重建对话并推进 next-llm', async () => {
    await setup('conv-commit');
    await buildConversationCommitCheckpoint(fs, resultDir);
    // sanity：cursor 处于 awaiting-conversation-commit（responseId 锚点 + 全部结果 id）
    const pre = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(pre.cursor).toEqual({
      kind: 'awaiting-conversation-commit',
      responseId: expect.any(String),
      toolResultIds: ['toolu_a', 'toolu_b'],
    });

    const llm = makeFakeLlm([endTurnChunks('rebuilt final')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });
    const text = await agent.run();

    expect(text).toBe('rebuilt final');
    // 不执行任何工具（结果全部来自已提交事实）
    expect(exec.calls).toHaveLength(0);
    // 已提交响应不重放请求：仅 runReact 的下一次 LLM 调用（stream 计数 = 1）
    expect(llm.callCount()).toBe(1);
    // 重建的 assistant + tool_result 消息进入对话
    const msgs = llm.streamCalls[0].messages as Message[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const blocks = lastUserToolResultBlocks(llm);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    expect(blocks.map((b) => b.content)).toEqual(['tool_a-ok', 'tool_b-ok']);
    // 对话保存后 cursor 已推进 next-llm（含 responseId 锚点）
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.fallbackReason).toBeUndefined();
    expect(post.cursor).toEqual({
      kind: 'next-llm',
      responseId: expect.any(String),
      conversationVersion: expect.any(Number),
    });
    // 无回退发生
    expect(auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK)).toHaveLength(0);
  });

  it('⑨ 对话保存失败 → 严格失败传播（不发起下一 LLM）、cursor 保持 awaiting-conversation-commit；修复后重启可恢复', async () => {
    await setup('save-fail');
    await buildConversationCommitCheckpoint(fs, resultDir);

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent, store } = makeAgent(fs, resultDir, {
      llm: llm.orchestrator,
      executor: exec.executor,
      auditRows,
      // 注入 messageStore.save 恒失败
      wrapMessageStore: (ms) => {
        (ms as unknown as { save: unknown }).save = async () => {
          throw new Error('injected save failure');
        };
        return ms;
      },
    });
    const commitSpy = vi.spyOn(store, 'commitConversation');

    // Phase 1934 Step B (F-12) 语义修正：恢复启用时 save 失败由 best-effort 改为
    // 严格失败 —— 原错传播（不掩护未提交游标发起下一 LLM）
    const err = await agent.run().then(
      () => { throw new Error('expected run to reject'); },
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain('injected save failure');
    // save 先败 → commitConversation 从未被调用、next-llm 未发布、不请求 LLM
    expect(commitSpy).not.toHaveBeenCalled();
    expect(llm.callCount()).toBe(0);
    const loaded = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(loaded.fallbackReason).toBeUndefined();
    expect(loaded.cursor?.kind).toBe('awaiting-conversation-commit');

    // 修复后重启：仅凭已提交事实重建对话并推进 next-llm（故障后现场可重建）
    const resume = await runResumePhase(fs, resultDir);
    expect(resume.text).toBe('recovered final');
    expect(resume.exec.calls).toHaveLength(0);
    expect(resume.llm.callCount()).toBe(1);
    const post = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(post.cursor?.kind).toBe('next-llm');
  });

  it('⑪ 最初消息缺席边界：next-llm 游标在场但 messages.json 从未落盘 → 保持全新构建（确定缺席非损坏、零回退留证）', async () => {
    await setup('next-llm-no-dialog');
    // 构造合法 next-llm 游标（无工具响应 + 对话提交），但 messages.json 从未写入
    const store0 = createSubAgentRecoveryStore({ fs, resultDir });
    await store0.llmResponseCommitted({
      response: {
        content: [{ type: 'text', text: 'prior final' }],
        stop_reason: 'end_turn',
      },
      llmInfo: { model: 'fake-model', inputTokens: 5, outputTokens: 5, latencyMs: 1 },
      committedAtMs: Date.now(),
    });
    await store0.commitConversation();
    const seeded = await store0.loadCursor();
    expect(seeded.cursor?.kind).toBe('next-llm');
    expect(await fs.exists(`${resultDir}/messages.json`)).toBe(false);

    const resume = await runResumePhase(fs, resultDir);

    expect(resume.text).toBe('recovered final');
    // source 'empty' = 确定不存在 → 保持全新构建（仅初始 user prompt 进入 LLM）
    const msgs = resume.llm.streamCalls[0].messages as Message[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'do the task' });
    // 缺席非损坏：零回退留证
    expect(resume.auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK)).toHaveLength(0);
  });

  it('⑫ next-llm 游标在场但 dialog I/O 失败 → typed recovery-required 阻断，不落 fresh baseline、不发起 LLM', async () => {
    await setup('next-llm-dialog-io');
    // 构造合法 next-llm 游标（首轮无工具响应 + 对话已提交），messages.json 在场
    const store0 = createSubAgentRecoveryStore({ fs, resultDir });
    await store0.llmResponseCommitted({
      response: {
        content: [{ type: 'text', text: 'prior final' }],
        stop_reason: 'end_turn',
      },
      llmInfo: { model: 'fake-model', inputTokens: 5, outputTokens: 5, latencyMs: 1 },
      committedAtMs: Date.now(),
    });
    await store0.commitConversation();
    const seeded = await store0.loadCursor();
    expect(seeded.cursor?.kind).toBe('next-llm');
    // dialog 边界不可读（已提交游标在场）
    const unreadableDialog = { source: 'io_error', error: 'injected dialog io', session: null };

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, {
      llm: llm.orchestrator,
      executor: exec.executor,
      auditRows,
      wrapMessageStore: (ms) => {
        (ms as unknown as { load: unknown }).load = async () => unreadableDialog;
        return ms;
      },
    });

    const err = await agent.run().then(
      () => { throw new Error('expected run to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryRequiredError);
    expect((err as SubAgentRecoveryRequiredError).reason).toContain('dialog_load_failed: injected dialog io');
    // 不发起新 LLM、不以 fresh baseline 覆盖不可读对话（finally 落盘被阻断跳过）
    expect(llm.callCount()).toBe(0);
    expect(await fs.exists(`${resultDir}/messages.json`)).toBe(false);
    const fallbackRows = auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK);
    expect(fallbackRows).toHaveLength(1);
    expect(String(fallbackRows[0].join(' '))).toContain('dialog_load_failed');
    // 已提交游标现场保留（next-llm 不被推进/覆写）
    const loaded = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(loaded.cursor?.kind).toBe('next-llm');
  });

  it('⑬ awaiting-tools 游标在场但 dialog I/O 失败 → typed 阻断，不执行工具、不发起 LLM', async () => {
    await setup('awaiting-tools-dialog-io');
    await buildAwaitingToolsCheckpoint(fs, resultDir);

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, {
      llm: llm.orchestrator,
      executor: exec.executor,
      auditRows,
      wrapMessageStore: (ms) => {
        (ms as unknown as { load: unknown }).load = async () => ({ source: 'io_error', error: 'injected dialog io', session: null });
        return ms;
      },
    });

    const err = await agent.run().then(
      () => { throw new Error('expected run to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryRequiredError);
    expect((err as SubAgentRecoveryRequiredError).reason).toContain('dialog_load_failed');
    // 不重执行已提交工具、不执行 pending 工具、不发起新 LLM
    expect(exec.calls).toHaveLength(0);
    expect(llm.callCount()).toBe(0);
    // cursor 现场保留（awaiting-tools 不被推进）
    const loaded = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(loaded.cursor).toMatchObject({ kind: 'awaiting-tools', pendingToolIds: ['toolu_b'] });
  });

  it('⑭ awaiting-tools 已提交响应不可读 → typed 阻断（不落 fresh baseline）', async () => {
    const { tempDir: dir } = await setup('response-unreadable');
    await buildAwaitingToolsCheckpoint(fs, resultDir);
    // 损坏已提交响应事实文件（cursor 仍指向它）
    const responsesDir = path.join(dir, resultDir, 'recovery', 'responses');
    const [responseFile] = await fsp.readdir(responsesDir);
    await fsp.writeFile(path.join(responsesDir, responseFile), 'corrupt{{{');

    const llm = makeFakeLlm([endTurnChunks('unreachable')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });

    const err = await agent.run().then(
      () => { throw new Error('expected run to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubAgentRecoveryRequiredError);
    expect((err as SubAgentRecoveryRequiredError).reason).toContain('committed_response_unreadable');
    expect(llm.callCount()).toBe(0);
    expect(exec.calls).toHaveLength(0);
    const fallbackRows = auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.RECOVERY_FALLBACK);
    expect(fallbackRows).toHaveLength(1);
    expect(String(fallbackRows[0].join(' '))).toContain('committed_response_unreadable');
    // 损坏事实现场保留（不清理、不覆盖）
    expect(await fsp.readFile(path.join(responsesDir, responseFile), 'utf-8')).toBe('corrupt{{{');
  });

  it('⑩ 正常完成路径末尾：cursor 为 next-llm 且含 responseId（对话持久化后才发布）', async () => {
    await setup('final-cursor');
    const llm = makeFakeLlm([TWO_TOOL_STEP, endTurnChunks('all done')]);
    const exec = makeFakeExecutor(async (toolName) => ({ success: true, content: `${toolName}-ok` }));
    const auditRows: unknown[][] = [];
    const { agent } = makeAgent(fs, resultDir, { llm: llm.orchestrator, executor: exec.executor, auditRows });
    const text = await agent.run();
    expect(text).toBe('all done');

    const loaded = await createSubAgentRecoveryStore({ fs, resultDir }).loadCursor();
    expect(loaded.fallbackReason).toBeUndefined();
    expect(loaded.cursor).toEqual({
      kind: 'next-llm',
      responseId: expect.any(String),
      conversationVersion: expect.any(Number),
    });
  });
});
