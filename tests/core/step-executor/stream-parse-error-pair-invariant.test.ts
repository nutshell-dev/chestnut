import { describe, it, expect, vi } from 'vitest';
import { createStreamState, flushToolUse, finalizeContent } from '../../../src/core/step-executor/stream.js';
import type { StepCallbacks } from '../../../src/core/step-executor/types.js';

describe('step-executor — stream parseError pair invariant (phase 1282)', () => {
  it('flushToolUse: parseError 时 emit tool_use + tool_result 双块，同 tool_use_id', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-x', name: 'write', input: '{"content":"partial' };

    flushToolUse(state);

    expect(state.contentBlocks).toHaveLength(2);
    expect(state.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call-x',
      name: 'write',
      input: {},
    });
    expect(state.contentBlocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-x',
      content: expect.stringContaining('Tool input JSON parse failed for "write"'),
      is_error: true,
    });
  });

  it('finalizeContent: parseError 时 emit tool_use + tool_result 双块，同 tool_use_id', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-y', name: 'read', input: '{"path":"/x' };

    finalizeContent(state);

    expect(state.contentBlocks).toHaveLength(2);
    expect(state.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call-y',
      name: 'read',
      input: {},
    });
    expect(state.contentBlocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-y',
      content: expect.stringContaining('Tool input JSON parse failed for "read"'),
      is_error: true,
    });
    expect(state.currentToolUse).toBeNull();
  });

  it('flushToolUse: parseError 时触发 onToolInputParseError callback', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-z', name: 'edit', input: '{bad' };
    const onToolInputParseError = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onToolInputParseError,
    };

    flushToolUse(state, callbacks);

    expect(onToolInputParseError).toHaveBeenCalledTimes(1);
    expect(onToolInputParseError).toHaveBeenCalledWith('edit', 'call-z', '{bad');
  });

  it('flushToolUse: 成功 parse 路径只 emit 1 个 tool_use 块，无 tool_result', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-ok', name: 'read', input: '{"path":"file.txt"}' };

    flushToolUse(state);

    expect(state.contentBlocks).toHaveLength(1);
    expect(state.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call-ok',
      name: 'read',
      input: { path: 'file.txt' },
    });
  });

  it('finalizeContent: 成功 parse 路径只 emit 1 个 tool_use 块，无 tool_result，并清空 currentToolUse', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-ok2', name: 'write', input: '{"content":"hi"}' };

    finalizeContent(state);

    expect(state.contentBlocks).toHaveLength(1);
    expect(state.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call-ok2',
      name: 'write',
      input: { content: 'hi' },
    });
    expect(state.currentToolUse).toBeNull();
  });
});
