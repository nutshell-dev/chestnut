/**
 * phase 1858 Step C (SA-D2): finally 落盘保存「本次实际使用」的 tools 单一快照。
 *
 * 根因：finally 原用 `this.toolsForLLM ?? []` —— caller 未传 toolsForLLM（工具集由
 * registry 派生）时，finally 以空数组覆盖 onStepComplete 已正确落盘的快照。
 *
 * 断言矩阵：
 * ① registry 派生场景 → finally 与 step 快照同值（含实际工具、非空覆盖）
 * ② 显式传入场景 → 零变化（显式集）
 * ③ run 未启动路径（ensureDir 失败）→ 旧行为不变（显式集 / 未传时真值 []）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import type { ToolExecutor } from '../../../src/foundation/tools/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/index.js';
import type { DialogSaveSnapshot } from '../../../src/foundation/dialog-store/index.js';
import type { StreamEvent } from '../../../src/foundation/stream/types.js';

const DERIVED_TOOLS = [
  { name: 'derived_a' },
  { name: 'derived_b' },
] as unknown as ToolDefinition[];
const EXPLICIT_TOOLS = [
  { name: 'explicit_only' },
] as unknown as ToolDefinition[];

class CollectingStreamWriter {
  events: StreamEvent[] = [];
  write(event: StreamEvent): void {
    this.events.push(event);
  }
}

function makeHarness(overrides: {
  toolsForLLM?: ToolDefinition[];
  ensureDirRejects?: boolean;
} = {}) {
  const mockFs: FileSystem = {
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    ensureDir: overrides.ensureDirRejects
      ? vi.fn().mockRejectedValue(new Error('ensureDir boom'))
      : vi.fn().mockResolvedValue(undefined),
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

  const savedSnapshots: DialogSaveSnapshot[] = [];
  const messageStore = {
    save: vi.fn().mockImplementation(async (snapshot: DialogSaveSnapshot) => {
      savedSnapshots.push(snapshot);
      return { blockIndexPersisted: true, assignedBlockIds: [] };
    }),
  };

  const auditWriter = { write: vi.fn() };
  const registry = {
    getAll: vi.fn().mockReturnValue([{ name: 'derived_raw' }]),
    formatForLLM: vi.fn().mockReturnValue(DERIVED_TOOLS),
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
    toolsForLLM: overrides.toolsForLLM,
    taskStreamWriter: new CollectingStreamWriter(),
    auditWriter: auditWriter as any,
    runReact: runReact as any,
  });

  return { agent, savedSnapshots, runReact, registry, auditWriter };
}

describe('phase 1858 Step C: finally 单一快照（SA-D2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① registry 派生（caller 不传 toolsForLLM）→ finally 快照含实际工具、非空覆盖', async () => {
    const { agent, savedSnapshots, runReact, registry } = makeHarness();

    runReact.mockImplementation(async (opts: { onStepComplete?: () => Promise<void> }) => {
      await opts.onStepComplete?.();
      return { finalText: 'ok', stopReason: 'end_turn' };
    });

    await agent.run();

    // step save + finally save 两次
    expect(savedSnapshots.length).toBeGreaterThanOrEqual(2);
    const stepSnapshot = savedSnapshots[0];
    const finallySnapshot = savedSnapshots[savedSnapshots.length - 1];

    // finally 与 run 期间同源（单快照）、且为 registry 派生实际集
    expect(stepSnapshot.toolsForLLM).toEqual(DERIVED_TOOLS);
    expect(finallySnapshot.toolsForLLM).toEqual(DERIVED_TOOLS);
    expect(finallySnapshot.toolsForLLM.length).toBeGreaterThan(0);
    expect(registry.formatForLLM).toHaveBeenCalled();
  });

  it('② 显式传入 toolsForLLM → finally 快照为显式集（零变化）', async () => {
    const { agent, savedSnapshots, runReact, registry } = makeHarness({ toolsForLLM: EXPLICIT_TOOLS });

    runReact.mockResolvedValue({ finalText: 'ok', stopReason: 'end_turn' });

    await agent.run();

    const finallySnapshot = savedSnapshots[savedSnapshots.length - 1];
    expect(finallySnapshot.toolsForLLM).toEqual(EXPLICIT_TOOLS);
    expect(registry.formatForLLM).not.toHaveBeenCalled();
  });

  it('③ run 未启动（ensureDir 失败）→ 显式集不为空覆盖（旧行为不变）', async () => {
    const { agent, savedSnapshots } = makeHarness({
      toolsForLLM: EXPLICIT_TOOLS,
      ensureDirRejects: true,
    });

    await expect(agent.run()).rejects.toThrow('ensureDir boom');

    expect(savedSnapshots).toHaveLength(1);
    expect(savedSnapshots[0].toolsForLLM).toEqual(EXPLICIT_TOOLS);
  });

  it('③ run 未启动且未传 toolsForLLM → 落 [] 为真值（未解析出实际使用集）', async () => {
    const { agent, savedSnapshots } = makeHarness({ ensureDirRejects: true });

    await expect(agent.run()).rejects.toThrow('ensureDir boom');

    expect(savedSnapshots).toHaveLength(1);
    expect(savedSnapshots[0].toolsForLLM).toEqual([]);
  });
});
