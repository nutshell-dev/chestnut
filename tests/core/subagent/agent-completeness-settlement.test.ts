/**
 * phase 1858 Step D (SA-D3): artifact completeness 纳入结算。
 *
 * 根因：finally 中 `void auditSubagentArtifactCompleteness(...).catch(() => {})` ——
 * fire-and-forget、rejection 被空 catch 静默吞掉，检查结论不参与结算。
 *
 * 断言矩阵：
 * ① 正常场景：检查结论持久化（ac4_ok 行）且 run() resolve 时已落盘（await 生效）
 * ② rejection 场景（audit writer 故障）：PERSIST_FAILED + stage=artifact_completeness 留证，
 *    run() 仍 resolve（不静默吞、不阻塞执行结果）
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
  loadResult?: unknown;
  auditWriteThrowsOn?: string;
} = {}) {
  const mockFs: FileSystem = {
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
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
    save: vi.fn().mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] }),
    load: vi.fn().mockResolvedValue(
      overrides.loadResult ?? {
        source: 'current',
        session: {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
          ],
        },
      },
    ),
  };

  const auditCalls: unknown[][] = [];
  const auditWriter = {
    write: vi.fn((event: string, ...cols: unknown[]) => {
      auditCalls.push([event, ...cols]);
      if (overrides.auditWriteThrowsOn && event === overrides.auditWriteThrowsOn) {
        throw new Error('audit write failed (disk down)');
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

describe('phase 1858 Step D: completeness 纳入结算（SA-D3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① 正常场景：run() resolve 时 ac4_ok 结论已落（await 生效）', async () => {
    const { agent, auditCalls, runReact, messageStore } = makeHarness();

    runReact.mockImplementation(async (opts: { stepCallbacks?: { onTextEnd?: () => void } }) => {
      opts.stepCallbacks?.onTextEnd?.();
      return { finalText: 'done', stopReason: 'end_turn' };
    });

    const text = await agent.run();

    expect(text).toBe('done');
    // 结算（save + completeness）已执行完才 resolve
    expect(messageStore.save).toHaveBeenCalled();
    const okRows = auditCalls.filter((c) => c[0] === SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_OK);
    expect(okRows).toHaveLength(1);
    expect(okRows[0]).toContain('kind=ac4_ok');
  });

  it('② completeness reject（audit 故障）→ PERSIST_FAILED 留证 + run 仍返回结果（不静默吞）', async () => {
    const { agent, auditCalls, runReact } = makeHarness({
      loadResult: { source: 'io_error', error: 'EACCES', session: null },
      auditWriteThrowsOn: SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_SKIPPED,
    });

    runReact.mockResolvedValue({ finalText: 'done', stopReason: 'end_turn' });

    const text = await agent.run();

    // 执行结果不被结算失败覆盖
    expect(text).toBe('done');

    // rejection 留证（原空 catch 静默吞掉的路径）
    const persistRows = auditCalls.filter((c) => c[0] === SUBAGENT_AUDIT_EVENTS.PERSIST_FAILED);
    expect(persistRows).toHaveLength(1);
    expect(persistRows[0]).toContain('stage=artifact_completeness');
    expect(persistRows[0]).toContain('agentId=test-agent');
    expect(String(persistRows[0].join(' '))).toContain('audit write failed');
  });
});
