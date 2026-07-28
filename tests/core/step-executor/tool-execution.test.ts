/**
 * Phase 1227 Step A/B: StepExecutor write-ordering authority.
 *
 * All ordering proofs use executor-issued reached barriers; no wall-clock sleep.
 */

import { describe, it, expect, vi } from 'vitest';
import { executeToolCalls } from '../../../src/core/step-executor/tool-execution.js';
import type { ToolUseBlock } from '../../../src/foundation/llm-provider/types.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/types.js';
import type { ExecContext, IToolExecutor, ToolRegistry } from '../../../src/foundation/tools/index.js';

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `toolu_${id}`, name, input };
}

function makeRegistry(readonlyNames: Set<string>): ToolRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    has: vi.fn(),
    getAll: vi.fn(),
    getForProfile: vi.fn(),
    formatForLLM: vi.fn(),
    get: (name: string) => {
      const readonly = readonlyNames.has(name);
      return {
        name,
        description: name,
        schema: { type: 'object', properties: {} },
        readonly,
        idempotent: readonly,
        profiles: ['subagent' as const],
        execute: vi.fn(),
      };
    },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('executeToolCalls ordering', () => {
  const ctx = { signal: undefined } as unknown as ExecContext;

  it('write tools execute sequentially in tool-call order without overlap', async () => {
    const events: string[] = [];
    const writeAReached = createDeferred<void>();
    const releaseWriteA = createDeferred<void>();

    const executor: IToolExecutor = {
      execute: vi.fn(async ({ toolName }: { toolName: string }) => {
        events.push(`enter:${toolName}`);
        if (toolName === 'write_a') {
          writeAReached.resolve();
          await releaseWriteA.promise;
        }
        events.push(`exit:${toolName}`);
        return { success: true, content: toolName } as ToolResult;
      }),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    };

    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'write_a'),
      makeToolUseBlock('2', 'write_b'),
    ];

    const execution = executeToolCalls(
      toolCalls,
      executor,
      ctx,
      makeRegistry(new Set()),
    );

    await writeAReached.promise;
    // write_a has entered execute() and is awaiting the release gate;
    // write_b must not have started yet because writes are sequential.
    expect(events).toEqual(['enter:write_a']);

    releaseWriteA.resolve();
    await execution;

    expect(events).toEqual([
      'enter:write_a',
      'exit:write_a',
      'enter:write_b',
      'exit:write_b',
    ]);
  });

  it('readonly tools are dispatched in a single parallel batch', async () => {
    const executor: IToolExecutor = {
      execute: vi.fn(),
      executeParallel: vi.fn(async () => [
        { success: true, content: 'read_a' } as ToolResult,
        { success: true, content: 'read_b' } as ToolResult,
      ]),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    };

    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'read_a'),
      makeToolUseBlock('2', 'read_b'),
    ];

    const results = await executeToolCalls(
      toolCalls,
      executor,
      ctx,
      makeRegistry(new Set(['read_a', 'read_b'])),
    );

    expect(executor.executeParallel).toHaveBeenCalledTimes(1);
    expect(executor.executeParallel).toHaveBeenCalledWith(
      [
        { toolName: 'read_a', args: {} },
        { toolName: 'read_b', args: {} },
      ],
      ctx,
    );
    expect(results.map(r => r.type)).toEqual(['tool_result', 'tool_result']);
  });

  it('mixed readonly + write runs readonly parallel first, then write sequentially', async () => {
    const events: string[] = [];
    const writeXReached = createDeferred<void>();
    const releaseWriteX = createDeferred<void>();

    const executor: IToolExecutor = {
      execute: vi.fn(async ({ toolName }: { toolName: string }) => {
        events.push(`write-enter:${toolName}`);
        if (toolName === 'write_x') {
          writeXReached.resolve();
          await releaseWriteX.promise;
        }
        events.push(`write-exit:${toolName}`);
        return { success: true, content: toolName } as ToolResult;
      }),
      executeParallel: vi.fn(async () => {
        events.push('readonly-batch');
        return [
          { success: true, content: 'read_y' } as ToolResult,
          { success: true, content: 'read_z' } as ToolResult,
        ];
      }),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    };

    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'write_x'),
      makeToolUseBlock('2', 'read_y'),
      makeToolUseBlock('3', 'read_z'),
      makeToolUseBlock('4', 'write_w'),
    ];

    const execution = executeToolCalls(
      toolCalls,
      executor,
      ctx,
      makeRegistry(new Set(['read_y', 'read_z'])),
    );

    await writeXReached.promise;
    // readonly batch must have completed before the first write entered.
    expect(events).toEqual(['readonly-batch', 'write-enter:write_x']);

    releaseWriteX.resolve();
    await execution;

    expect(events).toEqual([
      'readonly-batch',
      'write-enter:write_x',
      'write-exit:write_x',
      'write-enter:write_w',
      'write-exit:write_w',
    ]);
  });
});
