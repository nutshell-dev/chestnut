/**
 * Phase 1411 (reframe of phase 1409) — subagent onToolCallInput audit emit reverse.
 *
 * Verifies:
 * - onToolCallInput fires after args parsed → audit emit `tool_call_input` with
 *   typed cols (name + tool_use_id + args_size). args body 0 入 audit.
 * - args undefined-like (empty object) → audit row still emits with args_size=2
 *   (JSON.stringify({}).length = 2)
 * - args body NOT present in any emitted col
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import type { ToolExecutor } from '../../../src/foundation/tools/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';

vi.mock('../../../src/core/agent-executor/loop.js', () => ({
  runReact: vi.fn(),
}));

// phase 1489: ToolExecutor 注入 SubAgentOptions / 不再 vi.mock executor.js
function makeMockToolExecutor(): ToolExecutor {
  return {
    getExecContext: vi.fn().mockReturnValue({
      clawId: 'test-agent',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawDir: '/tmp/test',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      workspaceDir: path.join('/tmp/test', 'clawspace'),
      profile: 'subagent',
      fs: {},
      stepNumber: 0,
      maxSteps: 20,
      getElapsedMs: () => 0,
      incrementStep: vi.fn(),
    }),
  } as unknown as ToolExecutor;
}

import { runReact } from '../../../src/core/agent-executor/loop.js';

function makeSubAgent() {
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

  const mockAuditWriter = { write: vi.fn() };

  const mockRegistry = {
    getAll: vi.fn().mockReturnValue([]),
    formatForLLM: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistryImpl;

  const mockLLM = {
    call: vi.fn(),
    stream: vi.fn(),
    close: vi.fn(),
    healthCheck: vi.fn(),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as LLMOrchestrator;

  const sw = { write: vi.fn() };

  const agent = new SubAgent({
    agentId: 'test-agent',
    resultDir: 'tasks/queues/results/test-agent',
    messageStore: { save: vi.fn().mockResolvedValue(undefined) } as any,
    prompt: 'do something',
    toolExecutor: makeMockToolExecutor(),
    llm: mockLLM,
    registry: mockRegistry,
    fs: mockFs,
    maxSteps: 5,
    timeoutMs: 1000,
    taskStreamWriter: sw,
    auditWriter: mockAuditWriter,
  });

  return { agent, mockAuditWriter };
}

describe('Phase 1411 — onToolCallInput audit emit (index row)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverse 1 — args fully passed → emit tool_call_input with args_size', async () => {
    const { agent, mockAuditWriter } = makeSubAgent();

    (runReact as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: {
        onToolCallInput?: (name: string, toolUseId: string, args: Record<string, unknown>) => void;
      }) => {
        opts.onToolCallInput?.('summon', 'toolu_x1', { goal: 'do the thing', mode: 'shadow' });
        return { finalText: 'done', stopReason: 'end_turn' };
      },
    );

    await agent.run();

    const inputCalls = mockAuditWriter.write.mock.calls.filter(
      (call: any[]) => call[0] === SUBAGENT_AUDIT_EVENTS.TOOL_CALL_INPUT,
    );
    expect(inputCalls).toHaveLength(1);

    const cols = inputCalls[0].slice(1);
    expect(cols[0]).toBe('summon');
    // phase 140: named cols for tool_call_input
    expect(cols.some((c: string) => c === 'tool_use_id=toolu_x1')).toBe(true);

    const expectedSize = JSON.stringify({ goal: 'do the thing', mode: 'shadow' }).length;
    expect(cols.some((c: string) => c === `args_size=${expectedSize}`)).toBe(true);

    // reframe (phase 1411): args body 0 入 audit
    expect(cols.some((c: string) => c.includes('do the thing'))).toBe(false);
    expect(cols.some((c: string) => c.startsWith('args=') || c.startsWith('args_preview='))).toBe(false);
  });

  it('reverse 2 — empty args object → args_size=2', async () => {
    const { agent, mockAuditWriter } = makeSubAgent();

    (runReact as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: {
        onToolCallInput?: (name: string, toolUseId: string, args: Record<string, unknown>) => void;
      }) => {
        opts.onToolCallInput?.('noop', 'toolu_x2', {});
        return { finalText: 'done', stopReason: 'end_turn' };
      },
    );

    await agent.run();

    const inputCalls = mockAuditWriter.write.mock.calls.filter(
      (call: any[]) => call[0] === SUBAGENT_AUDIT_EVENTS.TOOL_CALL_INPUT,
    );
    expect(inputCalls).toHaveLength(1);
    const cols2 = inputCalls[0].slice(1) as string[];
    expect(cols2.some((c: string) => c === 'args_size=2')).toBe(true);
  });

  it('reverse 3 — no onToolCallInput fire → no tool_call_input emit', async () => {
    const { agent, mockAuditWriter } = makeSubAgent();

    (runReact as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return { finalText: 'done', stopReason: 'end_turn' };
    });

    await agent.run();

    const inputCalls = mockAuditWriter.write.mock.calls.filter(
      (call: any[]) => call[0] === SUBAGENT_AUDIT_EVENTS.TOOL_CALL_INPUT,
    );
    expect(inputCalls).toHaveLength(0);
  });
});
