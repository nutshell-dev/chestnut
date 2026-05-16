import { describe, it, expect, vi } from 'vitest';
import { executeSingleTool } from '../../../src/core/step-executor/tool-execution.js';

describe('step-executor — __parseError audit (P1.11 / α)', () => {
  it('audits tool_input_parse_failed when toolCall.input has __parseError flag', async () => {
    const events: Array<[string, ...(string | number)[]]> = [];
    const callbacks = {
      onToolInputParseError: (toolName: string, toolUseId: string, rawInput: string) => {
        events.push(['tool_input_parse_failed', toolName, toolUseId, `reason=parse_error`, `summary=${rawInput}`]);
      },
    };

    const toolCall = {
      id: 'tu1',
      name: 'someTool',
      input: { __parseError: true, __raw: '{bad json}' },
    };

    const executor = {
      execute: vi.fn(),
    };

    const ctx = {
      clawId: 'test',
      clawDir: '/tmp',
      profile: 'full',
      fs: {},
    } as any;

    const result = await executeSingleTool(toolCall as any, executor as any, ctx, callbacks as any);

    expect(result.success).toBe(false);
    expect(result.metadata).toEqual({ parseError: true });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe('tool_input_parse_failed');
    expect(events[0][1]).toBe('someTool');
    expect(events[0][2]).toBe('tu1');
    expect(events[0][3]).toBe('reason=parse_error');
    expect(events[0][4]).toBe('summary={bad json}');
  });
});
