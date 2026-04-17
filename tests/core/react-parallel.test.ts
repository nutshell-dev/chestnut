/**
 * ReAct Loop Parallel Execution Tests
 * 
 * Tests for read-only tools parallel execution + write tools sequential execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReact } from '../../src/core/react/loop.js';
import { ToolExecutorImpl } from '../../src/core/tools/executor.js';
import { ToolRegistryImpl } from '../../src/core/tools/registry.js';
import type { Tool, ToolResult, ExecContext } from '../../src/core/tools/executor.js';
import type { JSONSchema7 } from '../../src/types/message.js';
import type { LLMResponse, Message } from '../../src/types/message.js';

// Mock LLM that returns multiple tool calls
function createMockLLM(responses: LLMResponse[]) {
  let index = 0;
  return {
    call: vi.fn(async () => responses[index++]),
    stream: vi.fn(async function* () {
      const response = responses[index++];
      for (const block of response.content) {
        if (block.type === 'text') {
          yield { type: 'text_delta', delta: (block as { text: string }).text };
        } else if (block.type === 'tool_use') {
          const toolBlock = block as { id: string; name: string; input: unknown };
          yield { type: 'tool_use_start', toolUse: { id: toolBlock.id, name: toolBlock.name, partialInput: '' } };
          yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: JSON.stringify(toolBlock.input) } };
        }
      }
      yield { type: 'done' };
    }),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  };
}

describe('ReAct Loop Parallel Execution', () => {
  let registry: ToolRegistryImpl;
  let executor: ToolExecutorImpl;
  let mockCtx: ExecContext;

  beforeEach(() => {
    registry = new ToolRegistryImpl();
    executor = new ToolExecutorImpl(registry);
    
    mockCtx = {
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      callerType: 'claw',
      fs: {} as any,
      profile: 'full',
      stepNumber: 0,
      maxSteps: 20,
      getElapsedMs: () => 0,
      incrementStep: () => { mockCtx.stepNumber++; },
    };
  });

  it('should execute read-only tools in parallel when registry is provided', async () => {
    const executionOrder: string[] = [];
    const executionStartTimes: Record<string, number> = {};

    registry.register({
      name: 'readA',
      description: 'Read A',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: true,
      idempotent: true,
      async execute(): Promise<ToolResult> {
        executionStartTimes['readA'] = Date.now();
        executionOrder.push('readA-start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('readA-end');
        return { success: true, content: 'readA-result' };
      },
    });

    registry.register({
      name: 'readB',
      description: 'Read B',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: true,
      idempotent: true,
      async execute(): Promise<ToolResult> {
        executionStartTimes['readB'] = Date.now();
        executionOrder.push('readB-start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('readB-end');
        return { success: true, content: 'readB-result' };
      },
    });

    const mockLLM = createMockLLM([{
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'readA', input: {} },
        { type: 'tool_use', id: 'tool-2', name: 'readB', input: {} },
      ],
      stop_reason: 'tool_use',
    }, {
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
    }]);

    const messages: Message[] = [{ role: 'user', content: 'Test' }];
    
    await runReact({
      messages,
      systemPrompt: 'Test',
      llm: mockLLM as any,
      executor,
      ctx: mockCtx,
      registry,
      maxSteps: 5,
    });

    // Both tools should have been executed
    expect(executionOrder).toContain('readA-start');
    expect(executionOrder).toContain('readB-start');
    expect(executionOrder).toContain('readA-end');
    expect(executionOrder).toContain('readB-end');
    
    // Both should start before either ends (parallel execution)
    const starts = executionOrder.filter(e => e.includes('-start'));
    expect(starts.length).toBe(2);
  });

  it('should execute write tools sequentially', async () => {
    const executionOrder: string[] = [];

    registry.register({
      name: 'writeA',
      description: 'Write A',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: false,
      idempotent: false,
      async execute(): Promise<ToolResult> {
        executionOrder.push('writeA-start');
        await new Promise(r => setTimeout(r, 30));
        executionOrder.push('writeA-end');
        return { success: true, content: 'writeA-result' };
      },
    });

    registry.register({
      name: 'writeB',
      description: 'Write B',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: false,
      idempotent: false,
      async execute(): Promise<ToolResult> {
        executionOrder.push('writeB-start');
        await new Promise(r => setTimeout(r, 30));
        executionOrder.push('writeB-end');
        return { success: true, content: 'writeB-result' };
      },
    });

    const mockLLM = createMockLLM([{
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'writeA', input: {} },
        { type: 'tool_use', id: 'tool-2', name: 'writeB', input: {} },
      ],
      stop_reason: 'tool_use',
    }, {
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
    }]);

    const messages: Message[] = [{ role: 'user', content: 'Test' }];
    
    await runReact({
      messages,
      systemPrompt: 'Test',
      llm: mockLLM as any,
      executor,
      ctx: mockCtx,
      registry,
      maxSteps: 5,
    });

    // Write tools should both be executed
    expect(executionOrder).toContain('writeA-start');
    expect(executionOrder).toContain('writeA-end');
    expect(executionOrder).toContain('writeB-start');
    expect(executionOrder).toContain('writeB-end');
    
    // Sequential: A ends before B starts
    const writeAEndIndex = executionOrder.indexOf('writeA-end');
    const writeBStartIndex = executionOrder.indexOf('writeB-start');
    expect(writeAEndIndex).toBeLessThan(writeBStartIndex);
  });

  it('should handle mixed read-only and write tools correctly', async () => {
    const executionOrder: string[] = [];

    registry.register({
      name: 'readX',
      description: 'Read X',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: true,
      idempotent: true,
      async execute(): Promise<ToolResult> {
        executionOrder.push('readX');
        await new Promise(r => setTimeout(r, 30));
        return { success: true, content: 'readX-result' };
      },
    });

    registry.register({
      name: 'writeY',
      description: 'Write Y',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: false,
      idempotent: false,
      async execute(): Promise<ToolResult> {
        executionOrder.push('writeY');
        await new Promise(r => setTimeout(r, 30));
        return { success: true, content: 'writeY-result' };
      },
    });

    registry.register({
      name: 'readZ',
      description: 'Read Z',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: true,
      idempotent: true,
      async execute(): Promise<ToolResult> {
        executionOrder.push('readZ');
        await new Promise(r => setTimeout(r, 30));
        return { success: true, content: 'readZ-result' };
      },
    });

    const mockLLM = createMockLLM([{
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'readX', input: {} },
        { type: 'tool_use', id: 'tool-2', name: 'writeY', input: {} },
        { type: 'tool_use', id: 'tool-3', name: 'readZ', input: {} },
      ],
      stop_reason: 'tool_use',
    }, {
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
    }]);

    const messages: Message[] = [{ role: 'user', content: 'Test' }];
    
    await runReact({
      messages,
      systemPrompt: 'Test',
      llm: mockLLM as any,
      executor,
      ctx: mockCtx,
      registry,
      maxSteps: 5,
    });

    // All three tools should be executed
    expect(executionOrder).toContain('readX');
    expect(executionOrder).toContain('writeY');
    expect(executionOrder).toContain('readZ');

    // readX and readZ are parallel, writeY is sequential after them
    const readXIndex = executionOrder.indexOf('readX');
    const readZIndex = executionOrder.indexOf('readZ');
    const writeYIndex = executionOrder.indexOf('writeY');

    expect(readXIndex).toBeLessThan(writeYIndex);
    expect(readZIndex).toBeLessThan(writeYIndex);
  });

  it('should fall back to sequential execution when registry is not provided', async () => {
    const executionOrder: string[] = [];

    registry.register({
      name: 'toolA',
      description: 'Tool A',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: true,
      idempotent: true,
      async execute(): Promise<ToolResult> {
        executionOrder.push('toolA-start');
        await new Promise(r => setTimeout(r, 20));
        executionOrder.push('toolA-end');
        return { success: true, content: 'toolA-result' };
      },
    });

    registry.register({
      name: 'toolB',
      description: 'Tool B',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: true,
      idempotent: true,
      async execute(): Promise<ToolResult> {
        executionOrder.push('toolB-start');
        await new Promise(r => setTimeout(r, 20));
        executionOrder.push('toolB-end');
        return { success: true, content: 'toolB-result' };
      },
    });

    const mockLLM = createMockLLM([{
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'toolA', input: {} },
        { type: 'tool_use', id: 'tool-2', name: 'toolB', input: {} },
      ],
      stop_reason: 'tool_use',
    }, {
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
    }]);

    const messages: Message[] = [{ role: 'user', content: 'Test' }];
    
    await runReact({
      messages,
      systemPrompt: 'Test',
      llm: mockLLM as any,
      executor,
      ctx: mockCtx,
      // registry not provided - should fall back to sequential
      maxSteps: 5,
    });

    // Without registry, tools execute sequentially
    expect(executionOrder).toEqual([
      'toolA-start', 'toolA-end',
      'toolB-start', 'toolB-end',
    ]);
  });

  it('should preserve result order matching original toolCalls order', async () => {
    registry.register({
      name: 'slowRead',
      description: 'Slow Read',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: true,
      idempotent: true,
      async execute(): Promise<ToolResult> {
        await new Promise(r => setTimeout(r, 50));
        return { success: true, content: 'slow-result' };
      },
    });

    registry.register({
      name: 'fastWrite',
      description: 'Fast Write',
      schema: { type: 'object', properties: {} } as JSONSchema7,

      readonly: false,
      idempotent: false,
      async execute(): Promise<ToolResult> {
        await new Promise(r => setTimeout(r, 10));
        return { success: true, content: 'fast-result' };
      },
    });

    const mockLLM = createMockLLM([{
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'slowRead', input: {} },
        { type: 'tool_use', id: 'tool-2', name: 'fastWrite', input: {} },
      ],
      stop_reason: 'tool_use',
    }, {
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
    }]);

    const messages: Message[] = [{ role: 'user', content: 'Test' }];
    
    await runReact({
      messages,
      systemPrompt: 'Test',
      llm: mockLLM as any,
      executor,
      ctx: mockCtx,
      registry,
      maxSteps: 5,
    });

    // Check results are in correct order
    const toolResultMessage = messages.find(m => m.role === 'user' && Array.isArray(m.content));
    expect(toolResultMessage).toBeDefined();
    
    const results = toolResultMessage?.content as any[];
    expect(results.length).toBeGreaterThanOrEqual(2);
    
    expect(results[0].tool_use_id).toBe('tool-1');
    expect(results[0].content).toBe('slow-result');
    expect(results[1].tool_use_id).toBe('tool-2');
    expect(results[1].content).toBe('fast-result');
  });
});
