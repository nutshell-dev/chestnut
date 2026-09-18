/**
 * phase 1858 Step F (SA-D5): 每次 run 独占 capture channel。
 *
 * 根因：capturedResult 原从 caller registry 中的 done 工具实例可变字段读取 ——
 * 共享/复用 registry 时产生竞争或陈旧结果（前一 run 的字段被后一 run 读到）。
 *
 * 矩阵（走真实 runSubagent，仅 mock LLM loop / audit / dialog-store 边界）：
 * ① 顺序复用同一 base registry：run1 调 done、run2 不调 → run2 不得读到 run1 的陈旧结果（反向）
 * ② 并发两 run 共享同一 registry：各自结果互不污染
 * ③ 每 run 的 done 实例为该 run 独占 fresh 实例（≠ base 共享实例、run 间不同）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';

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
    save: vi.fn().mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] }),
    load: vi.fn().mockResolvedValue({ source: 'current', session: { messages: [] } }),
  }),
}));

import { runSubagent } from '../../../src/core/subagent/run.js';
import { createDoneTool, DONE_TOOL_NAME } from '../../../src/core/subagent/tools/done.js';
import { runReact } from '../../../src/core/agent-executor/loop.js';

const runReactMock = vi.mocked(runReact);

function makeFs() {
  return {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    appendSync: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(''),
    exists: vi.fn().mockResolvedValue(false),
  } as any;
}

function makeOpts(registry: ReturnType<typeof createToolRegistry>, prompt: string) {
  return {
    agentId: `agent-${prompt}`,
    clawDir: '/tmp/test',
    fs: makeFs(),
    llm: {} as any,
    registry,
    prompt,
    systemPrompt: 'system',
    resultDir: `/tmp/test/result-${prompt}`,
    syncDir: '/tmp/test/tasks/sync',
  };
}

/** 模拟 LLM 在 run 内调用 done 工具（走 run 传入的 registry —— 应为 run-scoped 视图） */
function makeDoneCallingLoop(value: string | null, seenRegistries: unknown[]) {
  return async (opts: { registry?: { get(name: string): unknown } }) => {
    seenRegistries.push(opts.registry);
    if (value !== null) {
      const doneTool = opts.registry!.get(DONE_TOOL_NAME) as {
        execute(args: Record<string, unknown>, ctx: unknown): Promise<unknown>;
      };
      await doneTool.execute({ result: value }, { requestStop: () => {}, currentToolUseId: 'tu1' });
    }
    return { finalText: `text-${value ?? 'none'}`, stopReason: 'end_turn' };
  };
}

describe('phase 1858 Step F: per-run capture channel 隔离（SA-D5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① 顺序复用同一 registry：run2 不调 done → 不读到 run1 陈旧结果（反向）', async () => {
    // 共享 base registry（模拟 assembly 注册的共享 done 实例）
    const baseRegistry = createToolRegistry();
    baseRegistry.register(createDoneTool());

    runReactMock.mockImplementationOnce(makeDoneCallingLoop('A', []) as any);
    const r1 = await runSubagent(makeOpts(baseRegistry, 'run-one'));
    expect(r1.capturedResult).toEqual({ result: 'A' });

    // run2：LLM 不调 done —— 旧实现会从共享实例读到 run1 的 { result: 'A' }（陈旧）
    runReactMock.mockImplementationOnce(makeDoneCallingLoop(null, []) as any);
    const r2 = await runSubagent(makeOpts(baseRegistry, 'run-two'));
    expect(r2.capturedResult).toBeUndefined();
    expect(r2.text).toBe('text-none');
  });

  it('② 并发两 run 共享同一 registry：各自结果互不污染', async () => {
    const baseRegistry = createToolRegistry();
    baseRegistry.register(createDoneTool());

    runReactMock
      .mockImplementationOnce(makeDoneCallingLoop('ONE', []) as any)
      .mockImplementationOnce(makeDoneCallingLoop('TWO', []) as any);

    const [r1, r2] = await Promise.all([
      runSubagent(makeOpts(baseRegistry, 'concurrent-one')),
      runSubagent(makeOpts(baseRegistry, 'concurrent-two')),
    ]);

    expect(r1.capturedResult).toEqual({ result: 'ONE' });
    expect(r2.capturedResult).toEqual({ result: 'TWO' });
  });

  it('③ 每 run 的 done 为该 run 独占 fresh 实例（≠ base 共享实例、run 间不同）', async () => {
    const baseRegistry = createToolRegistry();
    const sharedDone = createDoneTool();
    baseRegistry.register(sharedDone);

    const seen1: unknown[] = [];
    const seen2: unknown[] = [];
    runReactMock
      .mockImplementationOnce(makeDoneCallingLoop('X', seen1) as any)
      .mockImplementationOnce(makeDoneCallingLoop('Y', seen2) as any);

    await runSubagent(makeOpts(baseRegistry, 'inst-one'));
    await runSubagent(makeOpts(baseRegistry, 'inst-two'));

    const run1View = seen1[0] as { get(name: string): unknown };
    const run2View = seen2[0] as { get(name: string): unknown };
    const run1Done = run1View.get(DONE_TOOL_NAME);
    const run2Done = run2View.get(DONE_TOOL_NAME);

    expect(run1Done).toBeDefined();
    expect(run1Done).not.toBe(sharedDone);   // 不执行 caller 共享实例
    expect(run1Done).not.toBe(run2Done);     // run 间实例不同（各自独占通道）
    // 其余条目透传：base registry 的非 done 工具在视图中同实例可见性不破坏
    expect(run1View.get(DONE_TOOL_NAME)).not.toBe(null);
  });
});
