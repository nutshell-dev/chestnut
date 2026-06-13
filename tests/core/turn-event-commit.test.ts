/**
 * Phase 283: turn-event-commit typed function tests.
 *
 * Anchor: phase 227 invariants → by-construction equal via single commit function.
 */

import { describe, it, expect, vi } from 'vitest';
import { commitTurnEvent } from '../../src/core/turn-event-commit.js';

describe('commitTurnEvent', () => {
  it('text_end 调用 onTextEnd', () => {
    const onTextEnd = vi.fn();
    commitTurnEvent({ kind: 'text_end' }, { onTextEnd });
    expect(onTextEnd).toHaveBeenCalledTimes(1);
  });

  it('tool_call 调用 onToolCall 并传参', () => {
    const onToolCall = vi.fn();
    commitTurnEvent({ kind: 'tool_call', name: 'read', toolUseId: 'tu-1' }, { onToolCall });
    expect(onToolCall).toHaveBeenCalledWith('read', 'tu-1');
  });

  it('tool_result 调用 onToolResult 并传参', () => {
    const onToolResult = vi.fn();
    const result = { success: true, content: 'ok' };
    commitTurnEvent({ kind: 'tool_result', name: 'read', toolUseId: 'tu-1', result, step: 2, maxSteps: 10 }, { onToolResult });
    expect(onToolResult).toHaveBeenCalledWith('read', 'tu-1', result, 2, 10);
  });

  it('缺少 callback 时不抛错', () => {
    expect(() => commitTurnEvent({ kind: 'text_end' }, {})).not.toThrow();
    expect(() => commitTurnEvent({ kind: 'tool_call', name: 'read', toolUseId: 'tu-1' }, {})).not.toThrow();
    expect(() => commitTurnEvent({ kind: 'tool_result', name: 'read', toolUseId: 'tu-1', result: { success: true, content: 'ok' }, step: 1, maxSteps: 5 }, {})).not.toThrow();
  });
});
