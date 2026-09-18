/**
 * phase 1858 Step G (SA-D6): typed degraded evidence（agent 级）。
 *
 * 根因：step/dialog/log 持久化失败一律「audit 后继续返回成功」，outcome 不表达 artifact
 * 不完整；audit write 自身失败还可能反向终止 finally。
 *
 * 断言矩阵：
 * ① 全成功 → 零降级证据
 * ② step save 失败 → degraded 含 dialog/step_save 且执行结果不变
 * ③ 同类失败重复 → 折叠为一项（有界）
 * ④ audit write 故障 → 不终止、原结果保留、stderr 最后手段一行
 * ⑤ log append 失败 → degraded 含 log 项、run 正常
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import type { ToolExecutor } from '../../../src/foundation/tools/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
import type { StreamEvent } from '../../../src/foundation/stream/types.js';

class CollectingStreamWriter {
  events: StreamEvent[] = [];
  write(event: StreamEvent): void {
    this.events.push(event);
  }
}

function makeHarness(overrides: {
  saveRejects?: boolean;
  appendRejects?: boolean;
  auditThrowsOn?: string;
} = {}) {
  const mockFs: FileSystem = {
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
    append: overrides.appendRejects
      ? vi.fn().mockRejectedValue(new Error('append boom'))
      : vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn(),
    move: vi.fn().mockResolvedValue(undefined),
    copy: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0, mtime: new Date() }),
  } as unknown as FileSystem;

  const mockToolExecutor = {
    getExecContext: vi.fn().mockReturnValue({
      clawId: 'test-agent',
      clawDir: '/tmp/test',
      workspaceDir: path.join('/tmp/test', 'clawspace'),
      profile: 'subagent',
      fs: {},
      stepNumber: 0,
      maxSteps: 20,
      getElapsedMs: () => 0,
      incrementStep: vi.fn(),
    }),
  } as unknown as ToolExecutor;

  const messageStore = {
    save: overrides.saveRejects
      ? vi.fn().mockRejectedValue(new Error('save boom'))
      : vi.fn().mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] }),
    load: vi.fn().mockResolvedValue({ source: 'current', session: { messages: [] } }),
  };

  const auditCalls: unknown[][] = [];
  const auditWriter = {
    write: vi.fn((event: string, ...cols: unknown[]) => {
      auditCalls.push([event, ...cols]);
      if (overrides.auditThrowsOn && event === overrides.auditThrowsOn) {
        throw new Error('audit channel down');
      }
    }),
  };

  const registry = {
    getAll: vi.fn().mockReturnValue([]),
    formatForLLM: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistryImpl;
  const llm = {
    call: vi.fn(),
    stream: vi.fn(),
    close: vi.fn(),
    healthCheck: vi.fn(),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as LLMOrchestrator;

  const runReact = vi.fn();
  const agent = new SubAgent({
    agentId: 'test-agent',
    resultDir: 'tasks/queues/results/test-agent',
    messageStore: messageStore as any,
    prompt: 'do something',
    toolExecutor: mockToolExecutor,
    llm,
    registry,
    fs: mockFs,
    maxSteps: 5,
    timeoutMs: 1000,
    taskStreamWriter: new CollectingStreamWriter(),
    auditWriter: auditWriter as any,
    runReact: runReact as any,
  });

  return { agent, auditCalls, runReact, messageStore };
}

describe('phase 1858 Step G: degraded evidence（SA-D6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① 全成功 → 零降级证据', async () => {
    const { agent, runReact } = makeHarness();
    runReact.mockResolvedValue({ finalText: 'done', stopReason: 'end_turn' });

    await agent.run();

    expect(agent.getDegradedArtifacts()).toEqual([]);
  });

  it('② step save 失败 → degraded 含 dialog/step_save 且执行结果不变', async () => {
    const { agent, runReact } = makeHarness({ saveRejects: true });
    runReact.mockImplementation(async (opts: { onStepComplete?: () => Promise<void> }) => {
      await opts.onStepComplete?.();
      return { finalText: 'done', stopReason: 'end_turn' };
    });

    const text = await agent.run();

    expect(text).toBe('done');
    const degraded = agent.getDegradedArtifacts();
    const stepSave = degraded.find((d) => d.artifact === 'dialog' && d.stage === 'step_save');
    expect(stepSave).toBeDefined();
    expect(stepSave!.error).toContain('save boom');
  });

  it('③ 同类失败重复 → 折叠为一项（有界）', async () => {
    const { agent, runReact } = makeHarness({ saveRejects: true });
    runReact.mockImplementation(async (opts: { onStepComplete?: () => Promise<void> }) => {
      await opts.onStepComplete?.();
      await opts.onStepComplete?.();
      await opts.onStepComplete?.();
      return { finalText: 'done', stopReason: 'end_turn' };
    });

    await agent.run();

    const stepSaveEntries = agent.getDegradedArtifacts().filter(
      (d) => d.artifact === 'dialog' && d.stage === 'step_save',
    );
    expect(stepSaveEntries).toHaveLength(1);
  });

  it('④ audit write 故障 → run 不终止、原结果保留、stderr 最后手段一行', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { agent, runReact } = makeHarness({
      saveRejects: true,
      auditThrowsOn: SUBAGENT_AUDIT_EVENTS.PERSIST_FAILED,
    });
    runReact.mockImplementation(async (opts: { onStepComplete?: () => Promise<void> }) => {
      await opts.onStepComplete?.();
      return { finalText: 'done', stopReason: 'end_turn' };
    });

    const text = await agent.run();

    expect(text).toBe('done');
    const stderrLines = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrLines).toContain('[subagent] audit write failed');
    expect(stderrLines).toContain(SUBAGENT_AUDIT_EVENTS.PERSIST_FAILED);
    // 降级证据仍被收集（audit 只是留证通道、不影响收集）
    expect(agent.getDegradedArtifacts().some((d) => d.artifact === 'dialog')).toBe(true);
    stderrSpy.mockRestore();
  });

  it('⑤ log append 失败 → degraded 含 log 项、run 正常返回', async () => {
    const { agent, runReact } = makeHarness({ appendRejects: true });
    runReact.mockResolvedValue({ finalText: 'done', stopReason: 'end_turn' });

    const text = await agent.run();

    expect(text).toBe('done');
    const logEntry = agent.getDegradedArtifacts().find((d) => d.artifact === 'log');
    expect(logEntry).toBeDefined();
    expect(logEntry!.stage).toBe('append_log');
  });
});
