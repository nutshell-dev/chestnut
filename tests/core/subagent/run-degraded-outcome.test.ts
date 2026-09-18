/**
 * phase 1858 Step G (SA-D6): degraded evidence 并入 outcome（runSubagent 级）。
 *
 * ① 成功路径：持久化失败 → RunSubagentResult.degraded 可见、text 正常返回
 * ② 失败路径：错误对象携带 degraded（原错误保留）
 * ③ 全成功 → outcome.degraded 缺省（undefined）
 *
 * 走真实 runSubagent，仅 mock LLM loop / audit / dialog-store 边界。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { runSubagent } from '../../../src/core/subagent/run.js';
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

  it('① 成功路径：dialog 持久化失败 → outcome.degraded 可见、text 正常返回', async () => {
    dialogSaveMock.mockRejectedValue(new Error('dialog save boom'));
    runReactMock.mockImplementation(async (opts: { onStepComplete?: () => Promise<void> }) => {
      await opts.onStepComplete?.();
      return { finalText: 'final text', stopReason: 'end_turn' };
    });

    const result = await runSubagent(makeOpts());

    expect(result.text).toBe('final text');
    expect(result.degraded).toBeDefined();
    const stepSave = result.degraded!.find((d) => d.artifact === 'dialog' && d.stage === 'step_save');
    const finalSave = result.degraded!.find((d) => d.artifact === 'dialog' && d.stage === 'final_save');
    expect(stepSave).toBeDefined();
    expect(finalSave).toBeDefined();
    expect(stepSave!.error).toContain('dialog save boom');
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
});
