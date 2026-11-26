/**
 * phase 1858 Step G (SA-D6): degraded evidence 并入 outcome（runSubagent 级）。
 *
 * ① 持久化失败（Phase 1934 Step B 严格屏障）→ 原错传播、degraded 随错误对象移交
 * ② 失败路径：错误对象携带 degraded（原错误保留）
 * ③ 全成功 → outcome.degraded 缺省（undefined）
 *
 * 走真实 runSubagent，仅 mock LLM loop / audit / dialog-store 边界。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSubagentRunFs } from '../../helpers/subagent-run-fs.js';

const { dialogSaveMock } = vi.hoisted(() => ({ dialogSaveMock: vi.fn() }));

vi.mock('../../../src/core/agent-executor/loop.js', () => ({
  runReact: vi.fn(),
}));

vi.mock('../../../src/foundation/audit/index.js', () => ({
  createAuditWriter: vi.fn().mockReturnValue({ write: vi.fn(), summary: (s: string) => s, message: (s: string) => s, preview: (s: string) => s }),
  makeTraceId: vi.fn((value: string) => value),
}));

vi.mock('../../../src/foundation/dialog-store/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/foundation/dialog-store/index.js')>()),
  createDialogStore: vi.fn().mockReturnValue({
    save: dialogSaveMock,
    load: vi.fn().mockResolvedValue({ source: 'current', session: { messages: [] } }),
  }),
}));

import {
  createDefaultSubagentExecutionRunner,
  runSubagent,
} from '../../../src/core/subagent/run.js';
import { prepareSubagentInput } from '../../../src/core/subagent/execution-input.js';
import { createCanonicalToolManifest } from '../../../src/foundation/tools/index.js';
import { runReact } from '../../../src/core/agent-executor/loop.js';

const runReactMock = vi.mocked(runReact);

function makeFs() {
  return makeSubagentRunFs();
}

function makeOpts() {
  return {
    agentId: 'degraded-agent',
    clawDir: '/tmp/test',
    fs: makeFs(),
    llm: {} as any,
    registry: { getAll: vi.fn().mockReturnValue([]), formatForLLM: vi.fn().mockReturnValue([]), get: vi.fn(), has: vi.fn().mockReturnValue(false) } as any,
    prompt: 'do something',
    systemPrompt: 'system',
    resultDir: '/tmp/test/result-degraded',
    syncDir: '/tmp/test/tasks/sync',
  };
}

describe('phase 1858 Step G: degraded 并入 outcome（SA-D6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① dialog 持久化失败 →（Phase 1934 Step B 严格屏障）原错传播、degraded 证据随错误对象移交', async () => {
    dialogSaveMock.mockRejectedValue(new Error('dialog save boom'));
    runReactMock.mockImplementation(async (opts: { onStepComplete?: () => Promise<void> }) => {
      await opts.onStepComplete?.();
      return { finalText: 'final text', stopReason: 'end_turn' };
    });

    // Phase 1934 Step B (F-12) 语义修正：runSubagent 装配 recoveryStore，step_save
    // 持久化失败由 best-effort 改为严格失败 —— 原错传播（不包装、不掩护）；
    // 执行事实（step_save + finally final_save 两次失败）以 degraded 随错误移交。
    const err = await runSubagent(makeOpts()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('dialog save boom');
    expect(err.degraded).toBeDefined();
    const stepSave = err.degraded.find((d: { artifact: string; stage: string }) => d.artifact === 'dialog' && d.stage === 'step_save');
    const finalSave = err.degraded.find((d: { artifact: string; stage: string }) => d.artifact === 'dialog' && d.stage === 'final_save');
    expect(stepSave).toBeDefined();
    expect(finalSave).toBeDefined();
    expect(stepSave.error).toContain('dialog save boom');
  });

  it('② 失败路径：错误对象携带 degraded（原错误保留）', async () => {
    dialogSaveMock.mockRejectedValue(new Error('dialog save boom'));
    runReactMock.mockRejectedValue(new Error('loop boom'));

    const err = await runSubagent(makeOpts()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('loop boom');
    expect(err.degraded).toBeDefined();
    expect(err.degraded.some((d: { artifact: string }) => d.artifact === 'dialog')).toBe(true);
  });

  it('③ 全成功 → outcome.degraded 缺省（undefined）', async () => {
    dialogSaveMock.mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] });
    runReactMock.mockImplementation(async (opts: { onStepComplete?: () => Promise<void> }) => {
      await opts.onStepComplete?.();
      return { finalText: 'ok', stopReason: 'end_turn' };
    });

    const result = await runSubagent(makeOpts());

    expect(result.text).toBe('ok');
    expect(result.degraded).toBeUndefined();
  });

  it('④ 当前 options 适配为 JSON 输入；不可序列化运行时依赖由固定能力重建', async () => {
    dialogSaveMock.mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] });
    runReactMock.mockResolvedValue({ finalText: 'json input', stopReason: 'end_turn' });
    const fs = makeFs();
    const onIdleTimeout = vi.fn();
    const permissionChecker = vi.fn();
    const result = await runSubagent({
      ...makeOpts(),
      fs,
      onIdleTimeout,
      permissionChecker,
      execution: { callerKind: 'task', allowDone: undefined },
    });

    expect(result.text).toBe('json input');
    const document = JSON.parse(await fs.read('result-degraded/execution/input.json'));
    expect(document.input).toMatchObject({
      kind: 'run_subagent_options',
      agentId: 'degraded-agent',
      prompt: 'do something',
      execution: { callerKind: 'task' },
    });
    expect(document.input).not.toHaveProperty('fs');
    expect(document.input).not.toHaveProperty('llm');
    expect(document.input).not.toHaveProperty('registry');
    expect(document.input).not.toHaveProperty('onIdleTimeout');
    expect(document.input).not.toHaveProperty('permissionChecker');
  });

  it('⑥ 公开共享 runner 工厂按每次执行传递独立身份和绝对 deadline', async () => {
    dialogSaveMock.mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] });
    const observedRunIds: string[] = [];
    runReactMock.mockImplementation(async (input: { ctx: { clawId: string } }) => {
      observedRunIds.push(input.ctx.clawId);
      return { finalText: input.ctx.clawId, stopReason: 'end_turn' };
    });
    const opts = makeOpts();
    const runner = createDefaultSubagentExecutionRunner({
      clawDir: opts.clawDir,
      syncDir: opts.syncDir,
      fs: opts.fs,
      llm: opts.llm,
      registry: opts.registry,
    });
    const input = prepareSubagentInput({
      prompt: 'shared runner',
      tools: { manifest: createCanonicalToolManifest([]) },
    });

    const first = await runner.start({
      runId: 'shared-a', resultDir: 'result-shared-a', input, deadlineAtMs: 111_111, // time-fixture: bounded absolute-deadline input
    });
    const second = await runner.start({
      runId: 'shared-b', resultDir: 'result-shared-b', input, deadlineAtMs: 222_222, // time-fixture: bounded absolute-deadline input
    });
    await expect(first.completion).resolves.toMatchObject({
      kind: 'completed', content: 'shared-a', identity: { runId: 'shared-a', resultDir: 'result-shared-a' },
    });
    await expect(second.completion).resolves.toMatchObject({
      kind: 'completed', content: 'shared-b', identity: { runId: 'shared-b', resultDir: 'result-shared-b' },
    });
    expect(observedRunIds).toEqual(['shared-a', 'shared-b']);
    expect(JSON.parse(await opts.fs.read('result-shared-a/execution/attempts/1/claim.json')).deadlineAtMs).toBe(111_111);
    expect(JSON.parse(await opts.fs.read('result-shared-b/execution/attempts/1/claim.json')).deadlineAtMs).toBe(222_222);
  });

  it('⑤ 同身份/输入的便利调用连接同一活跃执行，自动 trace 不构成输入冲突', async () => {
    dialogSaveMock.mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] });
    let startedResolve!: () => void;
    const started = new Promise<void>(resolve => { startedResolve = resolve; });
    let release!: () => void;
    runReactMock.mockImplementation(async () => {
      startedResolve();
      await new Promise<void>(resolve => { release = resolve; });
      return { finalText: 'shared execution', stopReason: 'end_turn' };
    });
    const opts = makeOpts();
    const first = runSubagent(opts);
    const duplicate = runSubagent(opts);
    await started;
    expect(runReactMock).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ text: 'shared execution' }),
      expect.objectContaining({ text: 'shared execution' }),
    ]);
  });
});
